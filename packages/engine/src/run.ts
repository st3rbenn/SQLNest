import type { ResultColumn, ResultSet, Row } from "@sqlnest/snql";
import {
	capabilitiesFor,
	compensate,
	getMapper,
	lower,
	parse,
	plan,
	type SupportedEngine,
	tokenize
} from "@sqlnest/snql";
import type { Connection } from "./adapter";
import { EngineExecutionError, UnknownEngineError } from "./errors";

/**
 * Chemin de lecture de bout en bout : compile le SNQL pour le moteur de la
 * connexion, exécute le **pushdown** natif, puis applique la **compensation**
 * runtime sur les lignes. C'est le moment où SNQL renvoie de vraies lignes
 * depuis une vraie base.
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

	const logical = lower(parse(tokenize(source)));
	const physical = plan(logical, capabilities);
	// Le cast est un mensonge de type : un moteur peut avoir des capacités sans
	// codegen (ex. un futur adapter "kv"). getMapper renvoie alors undefined à
	// l'exécution — on le rattrape en erreur typée plutôt qu'un TypeError brut.
	const mapper = getMapper(engine as SupportedEngine) as
		| ReturnType<typeof getMapper>
		| undefined;
	if (mapper === undefined) {
		throw new EngineExecutionError(`Aucun codegen pour le moteur '${engine}'`);
	}
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
