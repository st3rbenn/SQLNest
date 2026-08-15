import type {
	NativeQuery,
	ResultColumn,
	ResultSet,
	Row,
	SchemaModel,
	SerializedSpan,
	Statement
} from "@sqlnest/snql";
import {
	assertIntrospectSupported,
	assertLetSupported,
	assertMutationCastTargetsSupported,
	assertMutationInsertSelectSupported,
	assertMutationUpsertSupported,
	assertMutationWriteJoinSupported,
	assertTransactionSupported,
	capabilitiesFor,
	collectIdentSpans,
	compensate,
	getMapper,
	inferResultColumns,
	lower,
	lowerIntrospect,
	lowerLet,
	lowerMutation,
	lowerRaw,
	lowerTransaction,
	parse,
	plan,
	type SupportedEngine,
	tokenize
} from "@sqlnest/snql";
import type { Connection } from "./adapter";
import { EngineExecutionError, UnknownEngineError } from "./errors";

/** ResultSet enrichi d'un drapeau `written` : distingue une écriture d'une lecture. */
export type QueryOutcome = ResultSet & {
	/**
	 * `true` si le statement était une mutation. Nécessaire car une écriture Mongo
	 * (update/delete) et une lecture vide ont toutes deux `columns: []` — l'UI ne
	 * peut pas les distinguer sur la seule forme du résultat.
	 */
	readonly written: boolean;
};

/**
 * Exécute un statement SNQL (lecture **ou** mutation) de bout en bout et renvoie
 * un ResultSet + `written`. Pour une mutation, `rowCount` = lignes affectées et
 * `rows` = les lignes renvoyées (RETURNING). C'est le moment où SNQL touche
 * vraiment la base.
 */
export async function runQuery(
	connection: Connection,
	source: string,
	schema?: SchemaModel
): Promise<QueryOutcome> {
	const engine = connection.engine;
	const capabilities = capabilitiesFor(engine);
	if (capabilities === undefined) {
		throw new UnknownEngineError(engine);
	}
	// Le cast est un mensonge de type : un moteur peut avoir des capacités sans
	// codegen (ex. un futur adapter "kv"). getMapper renvoie alors undefined à
	// l'exécution — on le rattrape en erreur typée plutôt qu'un TypeError brut.
	const mapper = getMapper(engine as SupportedEngine) as
		| ReturnType<typeof getMapper>
		| undefined;
	if (mapper === undefined) {
		throw new EngineExecutionError(`Aucun codegen pour le moteur '${engine}'`);
	}

	const statement: Statement = parse(tokenize(source));
	// Phase 3b-lite : collecte les spans par nom d'ident (col/table/alias) au
	// niveau AST. Attaché à la requête native pour que l'adapter le remonte
	// dans le pgError → résolution `column "X" does not exist` → span source.
	const identSpans = collectIdentSpans(statement);

	// Sprint T3/1 : introspection (`list tables`, `describe <t>`, ...). Le
	// mapper.mapIntrospect est absent sur les engines sans support —
	// assertIntrospectSupported remonte l'erreur claire avant TypeError.
	if (statement.operation === "introspect") {
		const introPlan = lowerIntrospect(statement, schema);
		assertIntrospectSupported(introPlan, capabilities);
		if (mapper.mapIntrospect === undefined) {
			throw new EngineExecutionError(
				`Aucun codegen 'introspect' pour le moteur '${engine}'`
			);
		}
		// Le namespace runtime (PG search_path / Mongo DB) vient de la
		// connection — le mapper le bind dans ses params.
		const ctx = connection.namespace !== undefined
			? { namespace: connection.namespace }
			: undefined;
		const native = mapper.mapIntrospect(introPlan, ctx);
		const executed = await connection.execute(native);
		// Sprint T3/2.3 : PG inline les postOps dans son SELECT wrapper, donc
		// le résultat est déjà filtré/projeté. Pour les engines qui renvoient
		// des rows brutes (Mongo), on applique compensate() côté runtime.
		if (
			native.kind === "mongo-introspect" &&
			introPlan.postOps !== undefined &&
			introPlan.postOps.length > 0
		) {
			const rows = compensate(introPlan.postOps, executed.rows);
			return {
				columns: columnsFromRows(rows, executed.columns),
				rows,
				rowCount: rows.length,
				written: false
			};
		}
		return { ...executed, written: false };
	}

	// Sprint T3/6 : CTE `let x = ...; body`. Le mapper.mapLet est absent
	// sur les engines sans support (Mongo/KV) — assertLetSupported remonte
	// l'erreur claire avant TypeError.
	if (statement.operation === "let") {
		const letPlan = lowerLet(statement, schema);
		assertLetSupported(letPlan, capabilities);
		if (mapper.mapLet === undefined) {
			throw new EngineExecutionError(
				`Aucun codegen 'let' (CTE) pour le moteur '${engine}'`
			);
		}
		const native = withIdentSpans(mapper.mapLet(letPlan), identSpans);
		// Le body du let peut être un read (find) ou un write (add/update/remove).
		// written = true ssi le body est une mutation — l'UI utilise ce flag
		// pour décider l'affichage rows vs rowCount.
		const written = letPlan.body.op === "insert"
			|| letPlan.body.op === "update"
			|| letPlan.body.op === "delete";
		return { ...(await connection.execute(native)), written };
	}

	// Sprint T3/4 : escape hatch `raw`. Bypass complet du pipeline SNQL —
	// PG passe le text SQL brut, Mongo passe le command à db.runCommand().
	// L'user assume la sémantique + les droits DB. Une lecture peut se
	// transformer en écriture (`raw "DELETE ..."`) → written=true safe-side
	// pour que l'UI n'affiche pas des rows fantômes.
	if (statement.operation === "raw") {
		const rawPlan = lowerRaw(statement);
		if (mapper.mapRaw === undefined) {
			throw new EngineExecutionError(
				`Aucun codegen 'raw' pour le moteur '${engine}'`
			);
		}
		const native = mapper.mapRaw(rawPlan);
		const executed = await connection.execute(native);
		return { ...executed, written: true };
	}

	// Sprint T2/15 : transaction bloc atomique. Le mapper.mapTransaction est
	// absent sur les engines sans support (Mongo/KV) — assertTransactionSupported
	// remonte l'erreur claire avant que TypeError explose.
	if (statement.operation === "transaction") {
		const txPlan = lowerTransaction(statement, schema);
		assertTransactionSupported(txPlan, capabilities);
		if (mapper.mapTransaction === undefined) {
			throw new EngineExecutionError(
				`Aucun codegen 'transaction' pour le moteur '${engine}'`
			);
		}
		const native = withIdentSpans(mapper.mapTransaction(txPlan), identSpans);
		return { ...(await connection.execute(native)), written: true };
	}

	if (statement.operation !== "select") {
		if (!capabilities.supports.has("mutate")) {
			throw new EngineExecutionError(
				`Le moteur '${engine}' ne supporte pas l'écriture (capacité 'mutate')`
			);
		}
		const mutation = lowerMutation(statement, schema);
		assertMutationCastTargetsSupported(mutation, capabilities);
		assertMutationUpsertSupported(mutation, capabilities);
		assertMutationWriteJoinSupported(mutation, capabilities);
		assertMutationInsertSelectSupported(mutation, capabilities);
		const native = withIdentSpans(mapper.mapMutation(mutation), identSpans);
		return { ...(await connection.execute(native)), written: true };
	}

	// Le schéma pilote l'inférence de multiplicité des joins `with` (many-to-one
	// → LEFT JOIN, one-to-many → embed array). Sans schéma, fallback embed.
	const physical = plan(lower(statement, schema), capabilities);
	const native = withIdentSpans(mapper.map(physical.pushdown), identSpans);

	const pushed = await connection.execute(native);
	// Enrichit les colonnes avec `type` + `nullable` dérivés du SchemaModel
	// quand disponible (CLI cache). Sinon on garde le fallback des adapters
	// (`type: "unknown"`, `nullable: true`).
	const typedColumns = schema
		? inferResultColumns(physical, schema)
		: pushed.columns;

	if (physical.compensation.length === 0) {
		return { columns: typedColumns, rows: pushed.rows, rowCount: pushed.rowCount, written: false };
	}

	// La compensation d'un join a besoin des données de la collection droite ;
	// le fetch réel côté I/O n'est pas encore branché (aucun moteur partiel
	// n'est connectable aujourd'hui — PG/Mongo poussent le join nativement).
	if (physical.compensation.some((op) => op.op === "join")) {
		throw new EngineExecutionError(
			"Compensation de join non branchée sur l'I/O (fetch du côté droit à venir)"
		);
	}

	const rows = compensate(physical.compensation, pushed.rows);
	return {
		columns: schema ? typedColumns : columnsFromRows(rows, pushed.columns),
		rows,
		rowCount: rows.length,
		written: false
	};
}

/**
 * Injecte `identSpans` sur la requête native pour les kinds qui l'exposent
 * (aujourd'hui : `sql` seulement). No-op pour les autres — Mongo n'a pas
 * de notion de "column not exist" avec ident quoté à surligner.
 */
function withIdentSpans(
	query: NativeQuery,
	identSpans: Readonly<Record<string, readonly SerializedSpan[]>>
): NativeQuery {
	if (query.kind !== "sql") return query;
	if (Object.keys(identSpans).length === 0) return query;
	return { ...query, identSpans };
}

/**
 * Colonnes déduites des lignes (union ordonnée des clés) après compensation.
 * Sur résultat vide, on retombe sur les colonnes du pushdown (au moins l'ordre
 * et les noms connus) plutôt que de renvoyer une liste vide.
 */
function columnsFromRows(
	rows: readonly Row[],
	fallback: readonly ResultColumn[]
): readonly ResultColumn[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!seen.has(key)) {
				seen.add(key);
				names.push(key);
			}
		}
	}
	return names.length > 0
		? names.map((name) => ({
				name,
				type: "unknown" as const,
				nullable: true
			}))
		: fallback;
}
