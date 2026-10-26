import { detectOrms } from "../../orm/detect";
import { checkHistory, keepsHistory } from "../../orm/history";
import { loadLocalConnections } from "../../services/local-connections";
import { defineOp } from "./op";

/**
 * Projet relié à la connexion servie (ADR-037 D2) : relié ou non, ORM,
 * `apply`, projet toujours là, table d'historique dans la base. Le chemin
 * reste sur la machine.
 */
export const projectStatusOp = defineOp({
	name: "projectStatus",
	async run(_req, ctx) {
		const project = loadLocalConnections()?.connections.find(
			(c) => c.name === ctx.connectionName
		)?.project;
		if (project === undefined) return { linked: false };
		let schema = ctx.schema.get();
		if (schema === undefined) {
			schema = await (await ctx.connection()).introspect();
			ctx.schema.set(schema);
		}
		const status = {
			linked: true,
			orm: project.orm,
			apply: project.apply,
			projectFound: detectOrms(project.path).some((d) => d.orm === project.orm)
		};
		// Prisma sous MongoDB : pas d'historique, donc pas de table attendue.
		if (!keepsHistory(project.orm, schema.engine)) {
			return { ...status, migrations: false };
		}
		const history = checkHistory(
			project.orm,
			schema.collections.map((c) => c.name)
		);
		return {
			...status,
			historyTable: { name: history.table, present: history.present }
		};
	}
});
