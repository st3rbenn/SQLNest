import { SchemaChangeError } from "../../orm/adapter";
import { applySchemaChange } from "../../orm/schema-change";
import {
	loadLocalConnections,
	resolveLocalConnectionUrl
} from "../../services/local-connections";
import { defineOp } from "./op";

/** Un changement à la fois : deux migrations écrites en même temps se marcheraient dessus. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Changement de schéma dans le projet relié à la connexion servie (ADR-037
 * D3) : migration écrite, modèle patché, base mise à jour si `apply`, puis
 * contrôles. Le chemin du projet reste sur la machine.
 */
export const applySchemaChangeOp = defineOp({
	name: "applySchemaChange",
	async run(req, ctx) {
		const project = loadLocalConnections()?.connections.find(
			(c) => c.name === ctx.connectionName
		)?.project;
		if (project === undefined) {
			throw new SchemaChangeError(
				`Aucun projet relié à « ${ctx.connectionName} » : sqlnest link-project ${ctx.connectionName} <dossier>`
			);
		}
		const databaseUrl = resolveLocalConnectionUrl(ctx.connectionName, ctx.env);
		const connection = await ctx.connection();
		const run = queue.then(() =>
			applySchemaChange({
				project,
				src: req.src,
				...(req.names !== undefined ? { names: req.names } : {}),
				databaseUrl,
				connection,
				env: ctx.env
			})
		);
		queue = run.catch(() => undefined);
		try {
			return await run;
		} finally {
			ctx.schema.invalidate();
		}
	}
});
