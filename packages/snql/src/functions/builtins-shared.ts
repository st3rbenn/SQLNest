/**
 * Helpers partagés entre les renderers PG/Mongo. Utilisés par les fonctions
 * unit-driven (date_part / date_trunc / date_add / date_diff) qui font un
 * switch statique sur un arg littéral string.
 */

import { SnqlError } from "../diagnostics";

/**
 * Duck-type un arg PlanExpr et extrait sa valeur si c'est un `{ kind: "literal",
 * value: <string> }`. Renvoie la string canonique lowercase.
 *
 * Le lower a déjà validé via `argEnum` — arriver ici avec un non-literal ou
 * une valeur hors whitelist = bug de synchronisation registre ↔ lower. Le
 * throw est defense-in-depth (`codegen_missing_function_mapping`).
 */
export function extractStringLiteralArg(
	arg: unknown,
	fnName: string,
	argIndex: number
): string {
	if (
		typeof arg === "object" &&
		arg !== null &&
		(arg as { kind?: unknown }).kind === "literal"
	) {
		const value = (arg as { value?: unknown }).value;
		if (typeof value === "string") {
			return value.toLowerCase();
		}
	}
	throw new SnqlError(
		`Fonction '${fnName}' arg ${argIndex + 1} : littéral string requis (bug lower — argEnum aurait dû bloquer)`,
		"codegen_missing_function_mapping"
	);
}
