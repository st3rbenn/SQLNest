import { SchemaChangeError } from "../../orm/adapter";
import {
	applySchemaChange,
	type SchemaChangeInput
} from "../../orm/schema-change";
import {
	loadLocalConnections,
	resolveLocalConnectionUrl
} from "../../services/local-connections";
import { defineOp, type OpContext } from "./op";

/** Un changement à la fois : deux migrations écrites en même temps se marcheraient dessus. */
let queue: Promise<unknown> = Promise.resolve();

/** Le changement demandé, dans le projet relié à la connexion servie. */
export async function schemaChangeInput(
	req: Pick<SchemaChangeInput, "src" | "names">,
	ctx: OpContext
): Promise<SchemaChangeInput> {
	const project = loadLocalConnections()?.connections.find(
		(c) => c.name === ctx.connectionName
	)?.project;
	if (project === undefined) {
		throw new SchemaChangeError(
			`Aucun projet relié à « ${ctx.connectionName} » : sqlnest link-project ${ctx.connectionName} <dossier>`
		);
	}
	return {
		project,
		src: req.src,
		...(req.names !== undefined ? { names: req.names } : {}),
		databaseUrl: resolveLocalConnectionUrl(ctx.connectionName, ctx.env),
		connection: await ctx.connection(),
		env: ctx.env
	};
}

/**
 * Changement de schéma dans le projet relié à la connexion servie (ADR-037
 * D3) : migration écrite, modèle patché, base mise à jour si `apply`, puis
 * contrôles. Le chemin du projet reste sur la machine.
 */
export const applySchemaChangeOp = defineOp({
	name: "applySchemaChange",
	async run(req, ctx) {
		const input = await schemaChangeInput(req, ctx);
		const run = queue.then(() => applySchemaChange(input));
		queue = run.catch(() => undefined);
		try {
			return await run;
		} finally {
			ctx.schema.invalidate();
		}
	}
});
