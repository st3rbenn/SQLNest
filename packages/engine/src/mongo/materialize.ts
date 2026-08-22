import type {
	Capabilities,
	JoinSources,
	LogicalPlan,
	Row,
	SchemaModel
} from "@sqlnest/snql";
import {
	compensate,
	type getMapper,
	linearize,
	plan,
	toCompensationOp
} from "@sqlnest/snql";
import type { Connection } from "../adapter";
import { EngineExecutionError } from "../errors";

/**
 * Plafond dur du nombre de rows matérialisables in-memory par un
 * `materializeSubplan()`. Au-delà, refus typé
 * `runtime_mongo_materialize_overflow` plutôt qu'OOM silencieux du process.
 * Override par workspace via `options.maxRows`.
 *
 * Défaut 10^6 = validé sur charge dev typique. À revalider en E2E large-scale
 * (>10^5 rows) sur subquery/cte/write-join.
 */
export const DEFAULT_MATERIALIZE_MAX_ROWS = 1_000_000;

export interface MaterializeOptions {
	/** Cap dur de rows. Défaut : {@link DEFAULT_MATERIALIZE_MAX_ROWS}. */
	readonly maxRows?: number;
	/**
	 * CTE déjà matérialisés — si le scan racine du subplan pointe une des
	 * clés, on court-circuite l'exécution native et compense les rows RAM.
	 * Utilisé par `materializeLet` (run.ts) pour chaîner CTE → subquery.
	 */
	readonly materialized?: Map<string, readonly Row[]>;
}

/**
 * Util public de matérialisation runtime. Exécute un LogicalPlan sub-select
 * nativement (ou via CTE court-circuit) et retourne les Rows. Consommé par
 * subquery uncorrelated, cte matérialisation et write-join fallback.
 *
 * Sémantique — le subplan matérialisé peut lui-même contenir des subqueries.
 * Le caller (typiquement `resolveSubqueries`) est responsable de rappeler
 * `resolveSubqueries` avant `materializeSubplan` pour aplatir en cascade.
 * On ne se rappelle PAS soi-même pour éviter les cycles avec le walker parent.
 *
 * Overflow — cap dur `maxRows` : après matérialisation, si `rows.length >
 * maxRows` on lève `runtime_mongo_materialize_overflow` (EngineExecutionError
 * avec code typé). Le user voit un message actionable pointant `limit` /
 * pagination.
 */
export async function materializeSubplan(
	subplan: LogicalPlan,
	connection: Connection,
	_schema: SchemaModel | undefined,
	capabilities: Capabilities,
	mapper: ReturnType<typeof getMapper>,
	options: MaterializeOptions = {}
): Promise<readonly Row[]> {
	// _schema est réservé pour un futur usage (mapper.map(schema) — pas encore
	// dans le contrat Mapper mais consommé par lowerMutation côté run.ts).
	// La signature reste alignée avec le call site pour éviter un refactor
	// downstream à la moindre extension.
	const materialized = options.materialized;
	const linear = linearize(subplan);
	const scanOp = linear[0];
	const maxRows = options.maxRows ?? DEFAULT_MATERIALIZE_MAX_ROWS;

	// Court-circuit : scan direct sur un CTE déjà en RAM → compensate pur, pas
	// de round-trip driver. Central pour le chaînage CTE → subquery / body.
	// Les autres CTE matérialisés sont passés en JoinSources pour que
	// compensate applique les join op sur des RAM sets.
	if (
		materialized !== undefined &&
		scanOp?.op === "scan" &&
		materialized.has(scanOp.collection)
	) {
		const cteRows = [...(materialized.get(scanOp.collection) ?? [])];
		const ops = linear.slice(1).map((op) => toCompensationOp(op));
		const rows = compensate(ops, cteRows, materializedAsJoinSources(materialized));
		return assertUnderCap(rows, maxRows);
	}

	// Chemin natif : pushdown vers le driver + compensation runtime pour ce
	// que l'engine ne sait pas pousser (typiquement rien sur PG, quelques ops
	// résiduelles sur Mongo).
	const physical = plan(subplan, capabilities);
	const native = mapper.map(physical.pushdown);
	const pushed = await connection.execute(native);
	const rows =
		physical.compensation.length === 0
			? [...pushed.rows]
			: compensate(
					physical.compensation,
					pushed.rows,
					materialized !== undefined
						? materializedAsJoinSources(materialized)
						: {}
				);
	return assertUnderCap(rows, maxRows);
}

function materializedAsJoinSources(
	materialized: ReadonlyMap<string, readonly Row[]>
): JoinSources {
	const sources: Record<string, readonly Row[]> = {};
	for (const [name, rows] of materialized) sources[name] = rows;
	return sources;
}

function assertUnderCap(rows: readonly Row[], maxRows: number): readonly Row[] {
	if (rows.length <= maxRows) return rows;
	throw new EngineExecutionError(
		`Matérialisation runtime dépasse le plafond (${rows.length} rows > ${maxRows}) — utilise \`limit\` sur le sous-plan ou pagine la source. Code : runtime_mongo_materialize_overflow.`
	);
}

/**
 * Code d'erreur d'overflow — exposé pour permettre aux tests de matcher
 * précisément sur le code sans dépendre du message. Consommé aussi par le
 * pattern d'erreurs enrichies côté frontend.
 */
export const RUNTIME_MONGO_MATERIALIZE_OVERFLOW =
	"runtime_mongo_materialize_overflow" as const;
