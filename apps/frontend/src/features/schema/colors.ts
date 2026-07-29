/**
 * Couleur dérivée d'un nom de table — pur, stable, sans dépendance. Le hash
 * donne une teinte ; saturation/luminosité fixes garantissent un rendu doux et
 * harmonieux entre tables. Deux tables partageant un préfixe reçoivent des
 * teintes proches (les préfixes contribuent le plus au hash), ce qui rend
 * visuellement lisibles les groupes comme `xref_p1…`.
 */

export interface TableColor {
	readonly header: string;
	readonly border: string;
	readonly text: string;
	readonly hue: number;
}

/** Hash déterministe → teinte 0-360. */
function hueOf(name: string): number {
	let h = 5381;
	for (let i = 0; i < name.length; i += 1) {
		h = ((h << 5) + h + name.charCodeAt(i)) & 0xffffffff;
	}
	return Math.abs(h) % 360;
}

/** Couleurs pastel + border colorée cohérente pour l'entête d'une carte de table. */
export function colorFor(name: string): TableColor {
	const hue = hueOf(name);
	return {
		header: `hsl(${hue}, 62%, 94%)`,
		border: `hsl(${hue}, 55%, 60%)`,
		text: `hsl(${hue}, 40%, 26%)`,
		hue
	};
}
