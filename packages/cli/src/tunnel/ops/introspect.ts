import { defineOp } from "./op";

export const introspectOp = defineOp({
	name: "introspect",
	async run(_req, ctx) {
		const schema = await (await ctx.connection()).introspect();
		// Prime le cache pour les prochains `runSnql` — évite un aller-
		// retour d'introspection dédié.
		ctx.schema.set(schema);
		return schema;
	}
});
