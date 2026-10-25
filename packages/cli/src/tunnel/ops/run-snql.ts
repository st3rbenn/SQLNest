import { runQuery } from "@sqlnest/engine";
import { defineOp } from "./op";

export const runSnqlOp = defineOp({
	name: "runSnql",
	async run(req, ctx) {
		const conn = await ctx.connection();
		// Le schéma type les colonnes du résultat. Introspection non fatale :
		// si elle échoue, la query s'exécute sans les types riches.
		let schema = ctx.schema.get();
		if (schema === undefined) {
			try {
				schema = await conn.introspect();
				ctx.schema.set(schema);
			} catch {
				// La query est primaire.
			}
		}
		const rs = await runQuery(conn, req.src, schema);
		// Un DDL change le schéma ; sans invalidation, la query suivante
		// typerait contre un cache périmé. Toute écriture invalide : les
		// mutations ne changent pas le schéma, mais un re-fetch au prochain
		// runSnql (~50 ms) coûte moins qu'un second parse pour distinguer le DDL.
		if (rs.written) ctx.schema.invalidate();
		return {
			columns: rs.columns,
			rows: rs.rows,
			rowCount: rs.rowCount,
			written: rs.written
		};
	}
});
