import type {
	ResultColumn,
	ResultSet,
	Row,
	SchemaModel,
	Statement
} from "@sqlnest/snql";
import {
	capabilitiesFor,
	compensate,
	getMapper,
	inferResultColumns,
	lower,
	lowerMutation,
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

	if (statement.operation !== "select") {
		if (!capabilities.supports.has("mutate")) {
			throw new EngineExecutionError(
				`Le moteur '${engine}' ne supporte pas l'écriture (capacité 'mutate')`
			);
		}
		const native = mapper.mapMutation(lowerMutation(statement));
		return { ...(await connection.execute(native)), written: true };
	}

	// Le schéma pilote l'inférence de multiplicité des joins `with` (many-to-one
	// → LEFT JOIN, one-to-many → embed array). Sans schéma, fallback embed.
	const physical = plan(lower(statement, schema), capabilities);
	const native = mapper.map(physical.pushdown);

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
