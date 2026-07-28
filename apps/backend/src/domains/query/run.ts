import { connect, runQuery } from "@sqlnest/engine";
import { resolveConnection } from "../connections";
import type { RunQueryBody } from "./run.schema";

export interface QueryResult {
	readonly columns: readonly { readonly name: string }[];
	readonly rows: readonly Record<string, unknown>[];
	readonly rowCount: number;
}

/** Rend une valeur JSON-safe : les `bigint` (précision) → chaîne, récursif. */
function jsonSafe(value: unknown): unknown {
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (Array.isArray(value)) {
		return value.map(jsonSafe);
	}
	if (value !== null && typeof value === "object" && !(value instanceof Date)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			out[key] = jsonSafe((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

/**
 * Exécute une requête SNQL sur le moteur demandé et renvoie le ResultSet.
 * `bigint` sérialisé en chaîne (JSON n'a pas de bigint). Connexion par requête.
 */
export async function runUserQuery(
	engine: RunQueryBody["engine"],
	source: string
): Promise<QueryResult> {
	const connection = await connect(resolveConnection(engine));
	try {
		const result = await runQuery(connection, source);
		return {
			columns: result.columns,
			rows: result.rows.map((row) => jsonSafe(row) as Record<string, unknown>),
			rowCount: result.rowCount
		};
	} finally {
		await connection.close();
	}
}
