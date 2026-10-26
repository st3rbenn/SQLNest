/**
 * Aperçu d'un changement (ADR-039 D3, D4), compilé dans le navigateur : le DDL
 * que le mode retenu produira (profil de l'ORM en mode migrations), et les
 * avertissements à lire avant d'appliquer. Aucun aller-retour.
 */

import {
	type DDLPlan,
	getMapper,
	lowerDDL,
	type NativeQuery,
	parse,
	type SchemaModel,
	type SupportedEngine,
	tokenize
} from "@sqlnest/snql";
import { ddlImpactHint } from "../../query/ddlImpactHints";
import type { EditMode } from "./editMode";

export interface ChangePreview {
	readonly plan?: DDLPlan;
	/** DDL natif : instructions SQL, ou opérations Mongo. */
	readonly statements: readonly string[];
	readonly warnings: readonly string[];
	readonly error?: string;
}

export function previewChange(
	src: string,
	schema: SchemaModel,
	mode: EditMode
): ChangePreview {
	try {
		const statement = parse(tokenize(src));
		if (statement.operation !== "ddl") {
			return {
				statements: [],
				warnings: [],
				error: "Un changement de schéma attend une instruction DDL"
			};
		}
		const plan = lowerDDL(
			statement as Parameters<typeof lowerDDL>[0],
			schema,
			mode.kind === "migrations" && mode.orm === "prisma"
				? { ormProfile: "prisma" }
				: {}
		);
		const native = getMapper(schema.engine as SupportedEngine).mapDDL?.(plan);
		const impact = ddlImpactHint(statement);
		return {
			plan,
			statements: native !== undefined ? nativeStatements(native) : [],
			warnings: impact !== null ? [impact.message] : []
		};
	} catch (err) {
		return {
			statements: [],
			warnings: [],
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

/** Instructions lisibles d'une requête native : le SQL, ou l'opération Mongo. */
function nativeStatements(native: NativeQuery): string[] {
	if (native.kind === "sql") return [native.text];
	if (native.kind === "transaction") {
		return native.steps.flatMap((step) =>
			step.kind === "statement" ? [step.query.text] : []
		);
	}
	const {
		engine: _engine,
		kind: _kind,
		...operation
	} = native as Record<string, unknown>;
	return [JSON.stringify(operation, null, 2)];
}
