/**
 * Couleur dérivée d'un nom de table — pur, stable, sans dépendance. Le hash
 * donne une teinte ; saturation/luminosité fixes garantissent un rendu doux et
 * harmonieux entre tables. Deux tables partageant un préfixe reçoivent des
 * teintes proches (les préfixes contribuent le plus au hash), ce qui rend
 * visuellement lisibles les groupes comme `xref_p1…`.
 *
 * Version dark : le shell d'une table est `#2C2C2C` (`--sqlnest-surface`).
 * On y dépose :
 *  - `border` : hue vive (S=55%, L=55%) pour rester lisible sur le shell
 *    sombre — sert aussi de pastille dans l'arbre + de bordure MiniMap.
 *  - `header` : tint SOMBRE de la même hue (S=45%, L=22%) posé sur le shell —
 *    donne un liseré coloré au dessus de la table sans passer les têtes en
 *    pastel clair. Le contraste avec le nom en `#FFFFFF` reste ≥ 8:1.
 *  - `text` : nuance moyenne (S=45%, L=80%) pour un éventuel usage de texte
 *    sur ce header (rare — le nom passe en `--sqlnest-text-primary` sans
 *    tinter). Conservé pour compatibilité avec l'API existante.
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

/** Couleurs dark-friendly dérivées du nom d'une table. */
export function colorFor(name: string): TableColor {
	const hue = hueOf(name);
	return {
		// Tint sombre pour le bandeau supérieur — visible sur #2C2C2C sans
		// devenir criard.
		header: `hsla(${hue}, 45%, 22%, 0.85)`,
		// Bordure vive — pastille dans l'arbre, contour et handle NodeResizer.
		border: `hsl(${hue}, 55%, 55%)`,
		// Nuance claire — usage compat (peut servir sur un futur tag).
		text: `hsl(${hue}, 45%, 80%)`,
		hue
	};
}
