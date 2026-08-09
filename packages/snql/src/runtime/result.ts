import type { SnqlType } from "../schema/model";
import type { Row } from "./compensate";

/**
 * Une colonne du résultat, engine-agnostique. `name` est la clé présente dans
 * chaque {@link Row}. `type` + `nullable` sont dérivés du SchemaModel via
 * `inferResultColumns()` quand le contexte le permet, sinon fallback safe
 * `"unknown"` + `nullable: true` (le rendu UI dégrade gracieusement).
 */
export interface ResultColumn {
	readonly name: string;
	readonly type: SnqlType;
	readonly nullable: boolean;
}

/**
 * **ResultSet normalisé** : la forme commune que tout moteur renvoie après
 * exécution, pour que le runtime de compensation et l'UI ignorent le moteur.
 * `columns` porte l'ordre des colonnes (utile même quand `rows` est vide).
 */
export interface ResultSet {
	readonly columns: readonly ResultColumn[];
	readonly rows: readonly Row[];
	readonly rowCount: number;
}
