/**
 * Changements de schéma qui cassent ce qui s'appuie sur l'ancienne forme
 * (ADR-036 D7) : requêtes enregistrées, code applicatif, ORM. Le moteur les
 * accepte ; la console le rappelle en `info` avant l'exécution.
 */

import type { Statement } from "@sqlnest/snql";
import type { DivergenceHint } from "./divergenceHints";

export function ddlImpactHint(statement: Statement): DivergenceHint | null {
	if (statement.operation !== "ddl") return null;
	if (statement.kind === "rename-column") {
		const { start, end } = statement.span;
		return {
			span: [start.offset, end.offset - start.offset],
			code: "ddl_rename_column_impact",
			message: `Les requêtes et le code qui utilisent '${statement.target}.${statement.column}' devront passer à '${statement.newName}'.`
		};
	}
	return null;
}
