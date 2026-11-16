import type { SchemaModel } from "../schema/model";

/**
 * État partagé d'un abaissement en cours : portées des requêtes englobantes
 * et schéma courant. Au niveau du module — JS n'a qu'un fil, et `lower()`
 * restaure tout en sortant, erreur comprise.
 */

/**
 * Portée d'une requête englobante, vue depuis une sous-requête corrélée :
 * alias déclarés (source et jointures `with`) et colonnes de la source, pour
 * résoudre `alias.champ` depuis l'intérieur d'un `(find ...)`.
 */
export interface OuterScope {
	readonly aliases: ReadonlySet<string>;
	readonly sourceColumns: ReadonlySet<string> | null;
	readonly collection: string;
	readonly alias?: string;
}

/**
 * Portées englobantes, de la plus externe à la plus proche. `lower()` y
 * empile la portée courante en entrant dans une sous-requête et la dépile
 * en sortant ; `checkAliasDefined` y résout les alias corrélés.
 *
 * La pile ne contient pas la portée courante : celle-ci vit dans
 * `scopeState.current`.
 */
export const outerScopeStack: OuterScope[] = [];

export const MAX_SUBQUERY_DEPTH = 32;

export const scopeState: {
	/**
	 * Portée de la requête en cours d'abaissement, tenue à jour par
	 * `lowerInternal` après chaque `with` qui ajoute un alias.
	 */
	current: OuterScope | null;
	/** Schéma courant, propagé aux sous-requêtes par `lowerExpr`. */
	schema: SchemaModel | undefined;
} = { current: null, schema: undefined };
