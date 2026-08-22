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
	assertMongoMutationWriteCastCoercive,
	assertMutationCastTargetsSupported,
	assertMutationInsertSelectSupported,
	assertMutationUpsertSupported,
	assertMutationWriteJoinSupported,
	assertTransactionSupported,
	assertUncorrelatedSubqueryForMaterialize,
	capabilitiesFor,
	detectOuterAliasesInSubplan,
	collectIdentSpans,
	compensate,
	getMapper,
	inferResultColumns,
	linearize,
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
import { materializeSubplan } from "./mongo/materialize";

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

	// Introspection (`list tables`, `describe <t>`, ...). Le
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
		const ctx =
			connection.namespace !== undefined
				? { namespace: connection.namespace }
				: undefined;
		const native = mapper.mapIntrospect(introPlan, ctx);
		const executed = await connection.execute(native);
		// PG inline les postOps dans son SELECT wrapper, donc le résultat est
		// déjà filtré/projeté. Pour les engines qui renvoient des rows brutes
		// (Mongo), on applique compensate() côté runtime.
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

	// CTE `let x = ...; body`.
	//   - Engine natif (PG capability `cte`) : compile en `WITH ... BODY_SQL`.
	//   - Engine sans cte native (Mongo/KV) : matérialisation — exécute les
	//     bindings séquentiellement, puis compensate() le body sur les rows
	//     RAM. Vision SNQL : porter les features aux engines qui ne les ont
	//     pas nativement.
	if (statement.operation === "let") {
		if (capabilities.supports.has("cte") && mapper.mapLet !== undefined) {
			const letPlan = lowerLet(statement, schema);
			const native = withIdentSpans(mapper.mapLet(letPlan), identSpans);
			const written =
				letPlan.body.op === "insert" ||
				letPlan.body.op === "update" ||
				letPlan.body.op === "delete";
			return { ...(await connection.execute(native)), written };
		}
		return await materializeLet(
			statement,
			schema,
			connection,
			capabilities,
			engine
		);
	}

	// Escape hatch `raw`. Bypass complet du pipeline SNQL — PG passe le text
	// SQL brut, Mongo passe le command à db.runCommand(). L'user assume la
	// sémantique + les droits DB. Une lecture peut se transformer en écriture
	// (`raw "DELETE ..."`) → written=true safe-side pour que l'UI n'affiche
	// pas des rows fantômes.
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

	// Transaction bloc atomique. Le mapper.mapTransaction est absent sur les
	// engines sans support (Mongo/KV) — assertTransactionSupported remonte
	// l'erreur claire avant que TypeError explose.
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
		assertMongoMutationWriteCastCoercive(mutation, capabilities);
		assertMutationUpsertSupported(mutation, capabilities);
		assertMutationWriteJoinSupported(mutation, capabilities);
		assertMutationInsertSelectSupported(mutation, capabilities);
		const native = withIdentSpans(mapper.mapMutation(mutation), identSpans);
		return { ...(await connection.execute(native)), written: true };
	}

	// Le schéma pilote l'inférence de multiplicité des joins `with` (many-to-one
	// → LEFT JOIN, one-to-many → embed array). Sans schéma, fallback embed.
	// Subquery `in (find ...)` / `exists (find ...)` — si l'engine n'a pas la
	// capability native (Mongo/KV), on matérialise chaque subquery puis on la
	// remplace par un array literal / bool literal dans le plan avant de
	// mapper. Idem "porter les features SQL manquantes".
	let logicalForPlan = lower(statement, schema);
	// Mongo a `subquery` capability avec strategy='materialize'. Le planner
	// accepte les sub-queries uncorrelated (correlated rejetées par
	// assertUncorrelatedSubqueryForMaterialize), le runtime les résout via
	// materializeSubplan avant plan(). Le refus correlated est fait AVANT
	// resolveSubqueries — sinon la matérialisation remplace les subqueries
	// par des littéraux et le planner assert (dans plan()) ne les voit plus.
	if (capabilities.subqueryStrategy === "materialize") {
		assertUncorrelatedSubqueryForMaterialize(logicalForPlan, capabilities);
		logicalForPlan = await resolveSubqueries(
			logicalForPlan,
			connection,
			schema,
			capabilities,
			mapper
		);
	}
	const physical = plan(logicalForPlan, capabilities);
	const native = withIdentSpans(mapper.map(physical.pushdown), identSpans);

	const pushed = await connection.execute(native);
	// Enrichit les colonnes avec `type` + `nullable` dérivés du SchemaModel
	// quand disponible (CLI cache). Sinon on garde le fallback des adapters
	// (`type: "unknown"`, `nullable: true`).
	const typedColumns = schema
		? inferResultColumns(physical, schema)
		: pushed.columns;

	if (physical.compensation.length === 0) {
		return {
			columns: typedColumns,
			rows: pushed.rows,
			rowCount: pushed.rowCount,
			written: false
		};
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
 * Matérialise un CTE sur un engine qui n'a pas la capability `cte` (Mongo,
 * KV). Vision SNQL : les features SQL manquantes sont portées via runtime
 * compensation. Pattern v1 supporté :
 *
 *   let x = find <collection> [stages];
 *   find x [stages]
 *
 * Contraintes v1 :
 *  - Body = find (select) uniquement. Mutations avec CTE natif seulement.
 *  - Body doit scan directement UN CTE (pas de join CTE ↔ vraie collection,
 *    pas de subquery référençant un CTE — Mongo refuse déjà subqueries).
 *  - Bindings ne peuvent pas référencer d'autres CTE (chainage v2).
 *
 * Ces contraintes garantissent qu'on n'a jamais à mixer données in-memory
 * et données engine dans la même exécution — le body tourne PUREMENT en
 * runtime `compensate` sur les rows matérialisées du CTE.
 */
async function materializeLet(
	statement: import("@sqlnest/snql").LetStatement,
	schema: SchemaModel | undefined,
	connection: Connection,
	capabilities: import("@sqlnest/snql").Capabilities,
	engine: string
): Promise<QueryOutcome> {
	const mapper = getMapper(engine as SupportedEngine);
	if (mapper === undefined) {
		throw new EngineExecutionError(`Aucun codegen pour le moteur '${engine}'`);
	}
	// Étape 1 : matérialise chaque binding dans l'ordre. Un binding qui scan
	//   - une vraie collection → pipeline engine natif (mapper.map + execute)
	//   - un CTE déjà matérialisé (chainage v2) → compensate pur sur les rows
	//     du CTE précédent
	// L'ordre séquentiel garantit qu'un binding ne peut voir qu'un CTE défini
	// plus haut dans la même liste (dépendance topologique respectée).
	const materialized = new Map<string, readonly Row[]>();
	for (const binding of statement.bindings) {
		const rows = await runQueryOnCte(
			binding.query,
			schema,
			connection,
			capabilities,
			mapper,
			materialized
		);
		materialized.set(binding.name, rows);
	}
	// Étape 2 : exécute le body selon son type.
	if (statement.body.operation === "select") {
		// Le body peut scan une vraie collection ET joindre un CTE
		// matérialisé. runQueryOnCte détecte ce cas et matérialise la real
		// coll AUSSI (cap runtime), puis compensate le join sur les 2 RAM
		// sets. Symétrique CTE↔real.
		const rows = await runQueryOnCte(
			statement.body,
			schema,
			connection,
			capabilities,
			mapper,
			materialized
		);
		return {
			columns: columnsFromRows(rows, []),
			rows,
			rowCount: rows.length,
			written: false
		};
	}
	// Body = mutation (add/update/remove). Cas v2 :
	//   - `add (find cte pick a, b) into t` : matérialise sourceQuery via CTE,
	//     construit un INSERT rows-literal, exécute nativement sur t.
	//   - Autres mutations : refus (v3 pour update/remove avec sub CTE).
	if (
		statement.body.operation === "insert" &&
		statement.body.sourceQuery !== undefined
	) {
		const sourceRows = await runQueryOnCte(
			statement.body.sourceQuery,
			schema,
			connection,
			capabilities,
			mapper,
			materialized
		);
		return await runInsertFromRows(
			statement.body,
			sourceRows,
			schema,
			connection,
			mapper
		);
	}
	throw new EngineExecutionError(
		`Body '${statement.body.operation}' avec CTE non supporté v2 sur '${engine}' — seuls 'find' (sur CTE direct) et 'add (find cte pick …) into t' sont portés via matérialisation. Le reste demande la capability native (PG).`
	);
}

/**
 * Exécute une Query soit nativement (source = vraie collection), soit via
 * compensate (source = CTE déjà matérialisé). Central pour le chainage et
 * pour le body find.
 */
async function runQueryOnCte(
	query: import("@sqlnest/snql").Query,
	schema: SchemaModel | undefined,
	connection: Connection,
	capabilities: import("@sqlnest/snql").Capabilities,
	mapper: ReturnType<typeof getMapper>,
	materialized: Map<string, readonly Row[]>
): Promise<readonly Row[]> {
	const sourceName = query.source.collection;
	// Court-circuit CTE : source = CTE déjà matérialisé → materializeSubplan
	// fait le compensate pur, sans resolveSubqueries — les subqueries
	// éventuelles dans les stages sont résolues par compensate directement.
	if (materialized.has(sourceName)) {
		return materializeSubplan(
			lower(query, schema),
			connection,
			schema,
			capabilities,
			mapper,
			{ materialized }
		);
	}
	// Source = vraie collection → pipeline engine natif. Étape supplémentaire
	// pour Mongo/KV : résoudre les subqueries `in (find cte_ou_coll …)` avant
	// materializeSubplan, sinon le planner refuse (capability subquery absente).
	let logicalPlan = lower(query, schema);
	// Mongo a `subquery` capability avec strategy='materialize'. Le planner
	// accepte les sub-queries uncorrelated (correlated rejetées par
	// assertUncorrelatedSubqueryForMaterialize). Le refus correlated est fait
	// AVANT resolveSubqueries — sinon la matérialisation remplace les
	// subqueries par des littéraux et le planner assert ne les voit plus.
	if (capabilities.subqueryStrategy === "materialize") {
		assertUncorrelatedSubqueryForMaterialize(logicalPlan, capabilities);
		logicalPlan = await resolveSubqueries(
			logicalPlan,
			connection,
			schema,
			capabilities,
			mapper,
			materialized
		);
	}
	// Join CTE↔real coll : le body scan une real coll et join un CTE
	// matérialisé. Un $lookup natif pointerait vers une coll inexistante
	// côté engine. Matérialise la real coll (scan seul), l'ajoute comme CTE
	// virtuel, puis re-exécute via court-circuit (compensate pur avec
	// materialized comme JoinSources). Le cap runtime s'applique.
	if (
		capabilities.subqueryStrategy === "materialize" &&
		hasJoinToMaterialized(logicalPlan, materialized)
	) {
		const scanOnlyPlan = extractScanOnlyPlan(logicalPlan);
		const realRows = await materializeSubplan(
			scanOnlyPlan,
			connection,
			schema,
			capabilities,
			mapper
		);
		const virtualMaterialized = new Map(materialized);
		virtualMaterialized.set(sourceName, realRows);
		return materializeSubplan(
			logicalPlan,
			connection,
			schema,
			capabilities,
			mapper,
			{ materialized: virtualMaterialized }
		);
	}
	return materializeSubplan(
		logicalPlan,
		connection,
		schema,
		capabilities,
		mapper
	);
}

/** True si le plan contient au moins un op join dont la collection est un CTE matérialisé. */
function hasJoinToMaterialized(
	logicalPlan: import("@sqlnest/snql").LogicalPlan,
	materialized: ReadonlyMap<string, readonly Row[]>
): boolean {
	for (const op of linearize(logicalPlan)) {
		if (op.op === "join" && materialized.has(op.collection)) return true;
	}
	return false;
}

/**
 * Extrait le scan racine du plan (sans stages downstream). Utilisé pour
 * matérialiser la real coll seule avant que compensate applique les joins CTE
 * + filters + project + sort + limit sur les 2 RAM sets. Optimisation future :
 * pousser aussi les filters racines pushdown-friendly (aucune ref CTE).
 */
function extractScanOnlyPlan(
	logicalPlan: import("@sqlnest/snql").LogicalPlan
): import("@sqlnest/snql").LogicalPlan {
	const ops = linearize(logicalPlan);
	const scan = ops[0];
	if (scan === undefined || scan.op !== "scan") {
		throw new EngineExecutionError(
			"extractScanOnlyPlan: scan racine manquant"
		);
	}
	return scan;
}

/**
 * INSERT SELECT via CTE matérialisé : les rows sont déjà en RAM (résultat
 * de la sourceQuery post-compensate). On les reformate en documents dans
 * l'ordre du pick de la sourceQuery, puis on appelle l'adapter avec un
 * MongoWriteQuery insert. Pour PG on ne devrait jamais tomber ici (capability
 * native), ce chemin est exclusivement engines sans cte.
 */
async function runInsertFromRows(
	insert: import("@sqlnest/snql").InsertStatement,
	sourceRows: readonly Row[],
	schema: SchemaModel | undefined,
	connection: Connection,
	mapper: ReturnType<typeof getMapper>
): Promise<QueryOutcome> {
	if (insert.sourceQuery === undefined) {
		throw new EngineExecutionError(
			"runInsertFromRows: sourceQuery attendu (bug appelant)"
		);
	}
	// Extrait les cols cibles depuis le pick de la sourceQuery (même logique
	// que lowerInsertSelect pour PG). `pick a as x, b` → cols cibles = [x, b].
	const pickStage = insert.sourceQuery.stages?.find((s) => s.type === "pick");
	if (pickStage === undefined || pickStage.type !== "pick") {
		throw new EngineExecutionError(
			"Le sourceQuery d'un 'add (find …) into t' doit avoir un pick explicite (mapping cols cibles)."
		);
	}
	const targetCols = pickStage.fields.map((f) => {
		if (f.alias !== undefined) return f.alias;
		if (f.path.length > 0) return f.path[f.path.length - 1] as string;
		throw new EngineExecutionError("pick field sans path ni alias");
	});
	// Construit les rows literal à insérer. sourceRows a déjà les bons noms
	// de cols (le pick a été appliqué via compensate) → mapping direct.
	const rowsLiteral = sourceRows.map((r) =>
		targetCols.map((c) => r[c] ?? null)
	);
	if (rowsLiteral.length === 0) {
		return { columns: [], rows: [], rowCount: 0, written: true };
	}
	const rebuiltInsert: import("@sqlnest/snql").InsertStatement = {
		operation: "insert",
		verb: insert.verb,
		collection: insert.collection,
		rows: rowsLiteral.map((values, rowIdx) => ({
			fields: targetCols.map((col, colIdx) => ({
				column: col,
				value: literalOf(values[colIdx] ?? null),
				span: insert.span
			})),
			span: insert.rows[rowIdx]?.span ?? insert.span
		})),
		span: insert.span
	};
	const mutationPlan = lowerMutation(rebuiltInsert, schema);
	const native = mapper.mapMutation(mutationPlan);
	const executed = await connection.execute(native);
	return { ...executed, written: true };
}

/**
 * Convertit une valeur JS scalaire en Expr littéral pour reconstruire un
 * InsertStatement AST. Utilisé par runInsertFromRows après matérialisation
 * CTE. Le span n'a plus de source utile (row d'un CTE, pas d'origine dans
 * le SNQL de l'user) — on met un span vide.
 */
function literalOf(value: unknown): import("@sqlnest/snql").Expr {
	const zeroSpan = {
		start: { offset: 0, line: 1, column: 1 },
		end: { offset: 0, line: 1, column: 1 }
	} as const;
	if (value === null || value === undefined) {
		return { type: "literal", value: { kind: "null" }, span: zeroSpan };
	}
	if (typeof value === "string") {
		return {
			type: "literal",
			value: { kind: "string", value },
			span: zeroSpan
		};
	}
	if (typeof value === "number") {
		return {
			type: "literal",
			value: { kind: "number", raw: String(value) },
			span: zeroSpan
		};
	}
	if (typeof value === "boolean") {
		return {
			type: "literal",
			value: { kind: "boolean", value },
			span: zeroSpan
		};
	}
	if (typeof value === "bigint") {
		return {
			type: "literal",
			value: { kind: "number", raw: value.toString() },
			span: zeroSpan
		};
	}
	// Fallback : stringify (Date, Object, etc.). Pour Mongo insert, l'adapter
	// hydrate en BSON via hydrateBson.
	return {
		type: "literal",
		value: { kind: "string", value: String(value) },
		span: zeroSpan
	};
}

/**
 * Porter les subqueries `in (find …)` / `exists (find …)` vers les engines
 * qui n'ont pas la capability `subquery` (Mongo/KV) via matérialisation.
 * Walker sur le LogicalPlan : chaque subquery rencontrée dans un predicate
 * est exécutée récursivement (native + compensate), puis remplacée par une
 * valeur littérale équivalente :
 *  - `x in (find ...)` → `x in [v1, v2, v3, ...]` (Expr.in avec array literal)
 *  - `exists (find ...)` → `true`/`false` selon rows.length
 *
 * Correlated subqueries : hors scope (chaque row outer aurait un contexte
 * différent → N+1 avec potentiellement des milliers de round-trips). Les
 * subqueries corrélées PG sont déjà refusées côté Mongo au lower.
 */
async function resolveSubqueries(
	logicalPlan: import("@sqlnest/snql").LogicalPlan,
	connection: Connection,
	schema: SchemaModel | undefined,
	capabilities: import("@sqlnest/snql").Capabilities,
	mapper: ReturnType<typeof getMapper>,
	materialized?: Map<string, readonly Row[]>
): Promise<import("@sqlnest/snql").LogicalPlan> {
	// Walker récursif sur les ops. Seuls filter (where) et aggregate.having
	// portent des predicates capables de contenir des subqueries. Les autres
	// ops (scan/project/sort/limit/join) n'en ont pas.
	const walkOp = async (
		op: import("@sqlnest/snql").LogicalPlan
	): Promise<import("@sqlnest/snql").LogicalPlan> => {
		switch (op.op) {
			case "scan":
				return op;
			case "filter":
				return {
					...op,
					input: await walkOp(op.input),
					predicate: await walkExpr(op.predicate)
				};
			case "project":
				return { ...op, input: await walkOp(op.input) };
			case "join":
				return { ...op, input: await walkOp(op.input) };
			case "sort":
				return { ...op, input: await walkOp(op.input) };
			case "limit":
				return { ...op, input: await walkOp(op.input) };
			case "aggregate":
				return op.having !== undefined
					? {
							...op,
							input: await walkOp(op.input),
							having: await walkExpr(op.having)
						}
					: { ...op, input: await walkOp(op.input) };
		}
	};

	const walkExpr = async (
		expr: import("@sqlnest/snql").PlanExpr
	): Promise<import("@sqlnest/snql").PlanExpr> => {
		switch (expr.kind) {
			case "subquery": {
				// Les subqueries CORRELATED sont laissées dans le plan pour que
				// le codegen Mongo les rewrite en lift-lookup
				// ($lookup{let,pipeline}). Seules les uncorrelated passent par
				// la matérialisation runtime en 1 shot.
				if (detectOuterAliasesInSubplan(expr.plan).length > 0) {
					return expr;
				}
				const rows = await executeInnerSelect(expr.plan);
				// Une subquery en position `values` d'un `in` est enveloppée juste
				// en dessous — mais on ne le sait pas ici. On remplace par un array
				// literal, et le walker parent (`in`) sait extraire les scalaires
				// via `flattenInSubqueryValues`. Ici on retourne une array literal
				// avec un item par row (chaque row = un objet à 1 col).
				return {
					kind: "array",
					items: rows.map((r) => rowToLiteralExpr(r))
				};
			}
			case "exists": {
				// Skip correlated pour lift-lookup côté codegen Mongo.
				if (detectOuterAliasesInSubplan(expr.subplan).length > 0) {
					return expr;
				}
				const rows = await executeInnerSelect(expr.subplan);
				// Un literal bool nu n'est pas un predicate valide côté Mongo
				// ($match refuse `true`). On wrap en compare toujours vrai/faux
				// (`1 = 1` / `1 = 0`) pour rester dans le contract PlanExpr et
				// que le codegen produise un $match compilable.
				return rows.length > 0
					? {
							kind: "compare",
							op: "eq",
							left: { kind: "literal", value: 1 },
							right: { kind: "literal", value: 1 }
						}
					: {
							kind: "compare",
							op: "eq",
							left: { kind: "literal", value: 1 },
							right: { kind: "literal", value: 0 }
						};
			}
			case "in":
				return {
					kind: "in",
					target: await walkExpr(expr.target),
					values: await flattenInSubqueryValues(expr.values)
				};
			case "and":
			case "or":
				return {
					kind: expr.kind,
					left: await walkExpr(expr.left),
					right: await walkExpr(expr.right)
				};
			case "compare":
				return {
					...expr,
					left: await walkExpr(expr.left),
					right: await walkExpr(expr.right)
				};
			case "arith":
				return {
					...expr,
					left: await walkExpr(expr.left),
					right: await walkExpr(expr.right)
				};
			case "not":
				return { kind: "not", operand: await walkExpr(expr.operand) };
			case "isNull":
				return { ...expr, operand: await walkExpr(expr.operand) };
			case "cast":
				return { ...expr, operand: await walkExpr(expr.operand) };
			case "call":
				return {
					...expr,
					args: await Promise.all(expr.args.map(walkExpr))
				};
			case "case":
				return {
					kind: "case",
					branches: await Promise.all(
						expr.branches.map(async (b) => ({
							cond: await walkExpr(b.cond),
							value: await walkExpr(b.value)
						}))
					),
					elseValue: await walkExpr(expr.elseValue)
				};
			case "object":
				return {
					kind: "object",
					entries: await Promise.all(
						expr.entries.map(async (e) => ({
							...e,
							value: await walkExpr(e.value)
						}))
					)
				};
			case "array":
				return {
					kind: "array",
					items: await Promise.all(expr.items.map(walkExpr))
				};
			case "windowCall":
				return {
					...expr,
					args: await Promise.all(expr.args.map(walkExpr))
				};
			// Feuilles sans sub-Expr.
			case "literal":
			case "field":
			case "upsertNew":
				return expr;
		}
	};

	// Cas spécial : `in [subquery]` — les rows de la subquery deviennent
	// directement les scalars du `in`, pas un array-of-arrays. Chaque row =
	// un objet à 1 col (le pick), on extrait cette valeur.
	const flattenInSubqueryValues = async (
		values: readonly import("@sqlnest/snql").PlanExpr[]
	): Promise<readonly import("@sqlnest/snql").PlanExpr[]> => {
		if (values.length === 1 && values[0]?.kind === "subquery") {
			// Skip correlated pour lift-lookup côté codegen Mongo.
			if (detectOuterAliasesInSubplan(values[0].plan).length > 0) {
				return values;
			}
			const rows = await executeInnerSelect(values[0].plan);
			return rows.map((r) => {
				const keys = Object.keys(r);
				const firstKey = keys[0];
				const raw = firstKey !== undefined ? r[firstKey] : null;
				return rowToLiteralExpr({ v: raw });
			});
		}
		// Sinon walk normalement (liste hétérogène).
		return Promise.all(values.map(walkExpr));
	};

	// Exécute un LogicalPlan sub-select nativement + compensate. Utilisé pour
	// les subqueries matérialisées. Peut contenir lui-même des subqueries →
	// résolue par la récursion (on rappelle resolveSubqueries d'abord).
	//
	// Délégué à `materializeSubplan()` (packages/engine/src/mongo/
	// materialize.ts) qui centralise court-circuit CTE + cap runtime.
	// Ordre : (1) court-circuit CTE via materializeSubplan si scan racine sur
	// CTE ; (2) sinon resolveSubqueries pour aplatir les subqueries imbriquées
	// puis materializeSubplan pour le pushdown natif.
	const executeInnerSelect = async (
		subPlan: import("@sqlnest/snql").LogicalPlan
	): Promise<readonly Row[]> => {
		const linear = linearize(subPlan);
		const scanOp = linear[0];
		if (
			materialized !== undefined &&
			scanOp?.op === "scan" &&
			materialized.has(scanOp.collection)
		) {
			return materializeSubplan(
				subPlan,
				connection,
				schema,
				capabilities,
				mapper,
				{ materialized }
			);
		}
		const resolved = await resolveSubqueries(
			subPlan,
			connection,
			schema,
			capabilities,
			mapper,
			materialized
		);
		return materializeSubplan(
			resolved,
			connection,
			schema,
			capabilities,
			mapper
		);
	};

	return walkOp(logicalPlan);
}

/**
 * Convertit une row (objet à 1+ cols) en PlanExpr littéral. Pour les
 * subqueries `in`, la row a une seule col — on extrait la valeur. Pour les
 * exists on retourne juste un bool. Cette version travaille avec un objet
 * `{ v: value }` pour uniformité.
 */
function rowToLiteralExpr(row: Row): import("@sqlnest/snql").PlanExpr {
	const keys = Object.keys(row);
	const firstKey = keys[0];
	const value = firstKey !== undefined ? row[firstKey] : null;
	if (value === null || value === undefined) {
		return { kind: "literal", value: null };
	}
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return { kind: "literal", value };
	}
	if (typeof value === "bigint") {
		return { kind: "literal", value };
	}
	// Fallback : stringify (Date, ObjectId, etc.).
	return { kind: "literal", value: String(value) };
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
