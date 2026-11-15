/**
 * Changements de schéma qui cassent ce qui s'appuie sur l'ancienne forme
 * (ADR-036 D7) : requêtes enregistrées, code applicatif, ORM. Le moteur les
 * accepte ; la console le rappelle en `info` avant l'exécution.
 */

import type { Statement } from "@sqlnest/snql";
import type { DivergenceHint } from "./divergenceHints";

export function ddlImpactHint(statement: Statement): DivergenceHint | null {
	if (statement.operation !== "ddl") return null;
	const { start, end } = statement.span;
	const span: DivergenceHint["span"] = [
		start.offset,
		end.offset - start.offset
	];
	if (statement.kind === "rename-column") {
		return {
			span,
			code: "ddl_rename_column_impact",
			message: `Les requêtes et le code qui utilisent '${statement.target}.${statement.column}' devront passer à '${statement.newName}'.`
		};
	}
	if (statement.kind === "drop-column") {
		return {
			span,
			code: "ddl_drop_column_impact",
			message: `Les requêtes et le code qui utilisent '${statement.target}.${statement.column}' échoueront ; ses valeurs seront perdues.`
		};
	}
	if (
		statement.kind === "alter-column" &&
		statement.action.kind === "set-type"
	) {
		const type = statement.action.type;
		const name = type.kind === "builtin" ? type.type : type.name;
		return {
			span,
			code: "ddl_set_type_impact",
			message: `Le code qui lit '${statement.target}.${statement.column}' recevra des valeurs de type ${name}.`
		};
	}
	if (
		statement.kind === "alter-column" &&
		statement.action.kind === "set-not-null"
	) {
		return {
			span,
			code: "ddl_set_not_null_impact",
			message: `Les écritures qui laissent '${statement.target}.${statement.column}' vide seront refusées.`
		};
	}
	return null;
}
