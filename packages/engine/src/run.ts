import type { ResultColumn, ResultSet, Row, Statement } from "@sqlnest/snql";
import {
	capabilitiesFor,
	compensate,
	getMapper,
	lower,
	lowerMutation,
	parse,
	plan,
	type SupportedEngine,
	tokenize
} from "@sqlnest/snql";
import type { Connection } from "./adapter";
import { EngineExecutionError, UnknownEngineError } from "./errors";

/**
 * Exécute un statement SNQL (lecture **ou** mutation) de bout en bout et renvoie
 * un ResultSet. Pour une mutation, `rowCount` = lignes affectées et `rows` = les
 * lignes renvoyées (RETURNING). C'est le moment où SNQL touche vraiment la base.
 */
export async function runQuery(
	connection: Connection,
	source: string
): Promise<ResultSet> {
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
		return connection.execute(native);
	}

	const physical = plan(lower(statement), capabilities);
	const native = mapper.map(physical.pushdown);

	const pushed = await connection.execute(native);
	if (physical.compensation.length === 0) {
		return pushed;
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
		columns: columnsFromRows(rows, pushed.columns),
		rows,
		rowCount: rows.length
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
	return names.length > 0 ? names.map((name) => ({ name })) : fallback;
}
