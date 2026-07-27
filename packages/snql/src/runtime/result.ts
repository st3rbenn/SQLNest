import type { Row } from "./compensate";

/**
 * Une colonne du résultat, engine-agnostique. `name` est la clé présente dans
 * chaque {@link Row}. Le typage riche (SnqlType) viendra du SchemaModel
 * (introspection) ; ici on garde le strict nécessaire pour l'affichage.
 */
export interface ResultColumn {
	readonly name: string;
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
