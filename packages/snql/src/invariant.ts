/**
 * Rend une valeur que le code tient pour présente, et lève si elle manque :
 * un invariant rompu se voit à l'endroit où il est rompu, pas trois appels
 * plus loin sous la forme d'un `undefined`.
 */
export function defined<T>(value: T): NonNullable<T> {
	if (value === undefined || value === null) {
		throw new Error("Invariant SNQL rompu : valeur absente");
	}
	return value;
}
