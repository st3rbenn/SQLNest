import { previewSchemaChange } from "../../orm/schema-change";
import { schemaChangeInput } from "./apply-schema-change";
import { defineOp } from "./op";

/**
 * Aperçu d'un changement dans le projet relié (ADR-039 D3) : les noms que le
 * modèle prendrait. Rien n'est écrit.
 */
export const previewSchemaChangeOp = defineOp({
	name: "previewSchemaChange",
	async run(req, ctx) {
		return previewSchemaChange(await schemaChangeInput(req, ctx));
	}
});
