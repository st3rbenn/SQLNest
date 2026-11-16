/**
 * Aperçu d'un changement (ADR-039 D3, D4), compilé dans le navigateur : le DDL
 * que le mode retenu produira (profil de l'ORM en mode migrations), les
 * avertissements à lire avant d'appliquer, et la saisie qui confirme une
 * suppression. Aucun aller-retour.
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
import { collectUnfilteredWrites } from "../../query/unfilteredWrites";
import { expectedFor } from "../../query/WriteConfirmBar";
import {
	type AddRefDraft,
	addRefSnql,
	LANGUAGE_REF_RULES,
	type RefRule,
	type RefRuleDefaults
} from "./changeSnql";
import type { EditMode } from "./editMode";

export interface ChangePreview {
	readonly plan?: DDLPlan;
	/** DDL natif : instructions SQL, ou opérations Mongo. */
	readonly statements: readonly string[];
	readonly warnings: readonly string[];
	/** Chaîne à retaper avant une suppression (ADR-029 D7), comme dans la console. */
	readonly confirm?: string;
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
		const [drop] = collectUnfilteredWrites(statement);
		return {
			plan,
			statements: native !== undefined ? nativeStatements(native) : [],
			warnings: impact !== null ? [impact.message] : [],
			...(drop !== undefined ? { confirm: expectedFor(drop) } : {})
		};
	} catch (err) {
		return {
			statements: [],
			warnings: [],
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

/**
 * Règles qu'une relation reçoit dans ce mode quand le SNQL n'en écrit aucune,
 * lues dans le plan compilé. Le profil Prisma met `cascade` à la mise à jour,
 * là où le langage seul met `restrict`.
 */
export function defaultRefRules(
	ref: Omit<AddRefDraft, "onDelete" | "onUpdate">,
	schema: SchemaModel,
	mode: EditMode
): RefRuleDefaults {
	const { plan } = previewChange(
		addRefSnql({ ...ref, ...LANGUAGE_REF_RULES }),
		schema,
		mode
	);
	if (plan?.kind !== "add-ref") return LANGUAGE_REF_RULES;
	return {
		onDelete: snqlRule(plan.ref.onDelete),
		onUpdate: snqlRule(plan.ref.onUpdate)
	};
}

/** Le plan écrit `set-null`, le langage `set null`. */
function snqlRule(rule: string): RefRule {
	return rule === "set-null" ? "set null" : (rule as RefRule);
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
