/**
 * Vérification d'arité — engine-agnostique, un seul validateur qui couvre les
 * 3 modes (fixe, range, variadic non-borné). Message FR aligné sur les autres
 * `SnqlError` du lower.
 */

import type { Arity } from "./registry";

/**
 * Renvoie un message d'erreur formaté si l'arité n'est pas respectée, sinon
 * `null`. Ne lève PAS elle-même — le caller compose l'erreur avec le span.
 */
export function checkArity(
	fnName: string,
	arity: Arity,
	actual: number
): string | null {
	if (actual < arity.min) {
		return `Fonction '${fnName}' attend ${describeArity(arity)}, reçu ${actual}`;
	}
	if (arity.max !== null && actual > arity.max) {
		return `Fonction '${fnName}' attend ${describeArity(arity)}, reçu ${actual}`;
	}
	return null;
}

/**
 * Description humaine d'une arité :
 *  - fixe : "1 argument", "2 arguments"
 *  - range : "1 ou 2 arguments" (only for min+1===max), sinon "entre <min> et <max>"
 *  - variadic non borné : "au moins <min> argument(s)"
 */
export function describeArity(arity: Arity): string {
	if (arity.max === null) {
		return `au moins ${arity.min} argument${arity.min > 1 ? "s" : ""}`;
	}
	if (arity.min === arity.max) {
		return `${arity.min} argument${arity.min > 1 ? "s" : ""}`;
	}
	if (arity.max === arity.min + 1) {
		return `${arity.min} ou ${arity.max} arguments`;
	}
	return `entre ${arity.min} et ${arity.max} arguments`;
}
