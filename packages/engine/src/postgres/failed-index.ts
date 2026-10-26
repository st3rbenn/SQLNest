import { type DDLPlan, getMapper, type SchemaModel } from "@sqlnest/snql";
import type { Connection } from "../adapter";
import { EngineExecutionError } from "../errors";

// L'index du plan, resté invalide sur sa table, qu'aucune construction en
// cours ne finira : celle d'une autre session (même nom, même table) le rendra
// valide. Lancée sous un autre rôle, sa table est masquée (`relid` nul) : elle
// compte aussi.
const LEFT_INVALID_SQL = `
	SELECT 1
	FROM pg_index ix
	JOIN pg_class i ON i.oid = ix.indexrelid
	JOIN pg_class t ON t.oid = ix.indrelid
	JOIN pg_namespace ns ON ns.oid = t.relnamespace
	WHERE ns.nspname = $1 AND t.relname = $2 AND i.relname = $3
		AND NOT ix.indisvalid
		AND NOT EXISTS (
			SELECT 1 FROM pg_stat_progress_create_index p
			JOIN pg_database d ON d.oid = p.datid
			WHERE d.datname = current_database()
				AND (p.relid IS NULL OR p.relid = t.oid)
		)`;

/**
 * Après l'échec d'un plan `add [unique] index` Postgres, retire l'index
 * invalide que `CREATE INDEX CONCURRENTLY` laisse (ADR-029 D18), sans verrou
 * exclusif sur la table. Seulement celui de cette tentative : absent du schéma
 * d'avant, et nom encore libre à l'essai (sinon 42P07). Lève si le contrôle ou
 * le retrait échoue.
 */
export async function dropFailedIndex(
	connection: Connection,
	plan: DDLPlan,
	before: SchemaModel | undefined,
	failure: unknown
): Promise<void> {
	if (plan.kind !== "add-index" && plan.kind !== "add-unique-index") return;
	if (connection.engine !== "postgres" || plan.concurrently === false) return;
	const existed = before?.collections
		.find((c) => c.name === plan.target)
		?.indexes?.some((i) => i.name === plan.name);
	if (existed === true) return;
	if (
		failure instanceof EngineExecutionError &&
		failure.pgError?.code === "42P07"
	) {
		return;
	}
	const left = await connection.execute({
		engine: "postgres",
		kind: "sql",
		text: LEFT_INVALID_SQL,
		params: [connection.namespace ?? "public", plan.target, plan.name]
	});
	if (left.rows.length === 0) return;
	const drop = getMapper("postgres").mapDDL?.(
		{
			op: "ddl",
			kind: "drop-index",
			target: plan.target,
			name: plan.name,
			ifExists: true,
			concurrently: true
		},
		connection.namespace !== undefined
			? { namespace: connection.namespace }
			: undefined
	);
	if (drop !== undefined) await connection.execute(drop);
}
