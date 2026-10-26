import type { SchemaModel } from "../schema-model";

/**
 * Détection de **candidats de relation** sur une base SANS FK déclarée
 * (legacy : le catalogue ne porte aucune contrainte, les liens n'existent que
 * par convention métier). Purement catalogue — colonnes + PK déjà chargées
 * dans le `SchemaModel` — donc ZÉRO requête réseau : tout est calculable
 * côté client au chargement du canvas.
 *
 * L'idée-clé pour rester rapide même sur 445 tables : l'utilisateur ne
 * déclare pas des liens un par un, il confirme des **hubs** que la détection
 * a déjà repérés. Sur une base legacy typique, une poignée de clés partagées
 * (une clé composite répétée dans 142 tables, une colonne pivot dans 61)
 * couvre une grande part du graphe — donc peu de confirmations = beaucoup
 * d'edges.
 *
 * Anti-bruit — le piège serait de classer en tête les colonnes d'audit
 * (`date_creation`, `user_modif`) qui sont répétées partout mais ne relient
 * rien. Trois ancrages, du plus fiable au plus faible :
 *   1. `primary-key` — le jeu de colonnes EST la PK d'une table : cette table
 *      est la référence (le côté « one »), certaine. Une colonne d'audit
 *      n'est jamais une PK → jamais de faux positif ici.
 *   2. `name` — pas de PK, mais une table porteuse matche le nom des colonnes
 *      (`ANN_CODE_ANNUAIRE` → table `ANN_ANNUAIRE`). Suggestion.
 *   3. `co-occurrence` — plusieurs colonnes co-apparaissent exactement dans
 *      le même ensemble de tables : signal de clé composite même sans PK ni
 *      nom. Référence devinée, à confirmer.
 *
 * Les passes non-ancrées (2, 3) écartent les colonnes portées par plus de
 * `AUDIT_RATIO` des tables — au-delà, c'est presque sûrement un attribut
 * d'audit, pas une clé de jointure.
 */

/** Une colonne portée par moins de tables ne relie rien (référence seule). */
const MIN_CARRIERS = 2;

/**
 * Fraction du total de tables au-delà de laquelle une colonne est traitée
 * comme un attribut d'audit (répété partout) et exclue des passes
 * non-ancrées. Ne s'applique PAS à la passe PK : une PK reste une clé même
 * très référencée.
 */
const AUDIT_RATIO = 0.6;

/**
 * Le filtre audit n'a de sens qu'à l'échelle : sur un petit schéma, une
 * colonne partagée par 70% des tables peut être un vrai hub central, et le
 * panneau est de toute façon assez court pour être scanné à l'œil. En
 * dessous de ce seuil on ne borne pas par le haut. C'est une mesure
 * anti-bruit pour les grosses bases legacy (cible du feature).
 */
const AUDIT_MIN_TABLES = 20;

/** Plafond de colonnes d'une clé composite — au-delà elle devient illisible. */
const MAX_COMPOSITE_COLS = 4;

export type CandidateAnchor = "primary-key" | "name" | "co-occurrence";

export interface RelationCandidate {
	/** Identité stable — clé React + identité de règle pour LR/2. */
	readonly id: string;
	/** La/les colonne(s) de jointure partagée(s). 1 = hub colonne, ≥2 = hub composite. */
	readonly columns: readonly string[];
	/**
	 * Toutes les tables portant TOUTES les `columns`, référence incluse,
	 * triées. `carriers.length` = « présent dans N tables » ;
	 * `carriers.length - 1` = edges créés à la confirmation (la référence ne
	 * pointe pas vers elle-même).
	 */
	readonly carriers: readonly string[];
	/** Table de référence suggérée (le côté « one ») — le pré-tri. */
	readonly suggestedReference: string;
	/**
	 * Sous-ensemble des `carriers` plausibles comme référence, pour le
	 * dropdown de confirmation (LR/2). Contient toujours `suggestedReference`.
	 */
	readonly referenceOptions: readonly string[];
	/** Comment la référence a été devinée — pilote la confiance affichée + le tri. */
	readonly anchor: CandidateAnchor;
}

/** Segments minuscules d'un nom : `DOS_DOSSIER` → ["dos", "dossier"]. */
function segments(name: string): string[] {
	return name
		.toLowerCase()
		.split("_")
		.filter((s) => s.length > 0);
}

/** Token de préfixe d'une colonne : segment avant le premier `_`, insensible à la casse. */
function prefixToken(col: string): string {
	const i = col.indexOf("_");
	return (i === -1 ? col : col.slice(0, i)).toLowerCase();
}

/** Une table matche-t-elle un token de préfixe ? (`ann` → `ANN_ANNUAIRE`). */
function nameMatchesToken(tableName: string, token: string): boolean {
	const t = tableName.toLowerCase();
	return t === token || t.startsWith(`${token}_`);
}

/** Token majoritaire parmi un groupe de colonnes (départage : première colonne). */
function groupToken(columns: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const c of columns) {
		const tk = prefixToken(c);
		counts.set(tk, (counts.get(tk) ?? 0) + 1);
	}
	let best = prefixToken(columns[0] ?? "");
	let bestN = 0;
	for (const [tk, n] of counts) {
		if (n > bestN) {
			best = tk;
			bestN = n;
		}
	}
	return best;
}

/**
 * Choisit la table de référence parmi des candidates. D'abord celles dont le
 * nom matche le token de préfixe des colonnes ; parmi elles, on préfère celle
 * dont le **nom-racine** (segments après le préfixe) réapparaît dans les
 * colonnes de la clé — `ANN_ANNUAIRE` ↔ `ANN_CODE_ANNUAIRE`, `DOS_DOSSIER` ↔
 * `..._DOSSIER`. Bien plus fiable que « le nom le plus court » (qui élisait
 * `ANN_EXCLU`/`DOS_ERREUR`). À défaut de racine commune, le plus court.
 *
 * `matched` dit s'il y avait au moins un match de préfixe réel : les passes
 * non-ancrées s'en servent pour distinguer une vraie suggestion par le nom
 * d'un simple repli (la référence est alors devinée, ancrage co-occurrence).
 */
function pickReference(
	columns: readonly string[],
	candidateTables: readonly string[],
	token: string
): { reference: string | undefined; options: string[]; matched: boolean } {
	const columnSegs = new Set<string>();
	for (const c of columns) for (const s of segments(c)) columnSegs.add(s);
	const matches = candidateTables.filter((t) => nameMatchesToken(t, token));
	const pool = matches.length > 0 ? matches : [...candidateTables];
	const scored = pool
		.map((t) => ({
			t,
			rootMatch: segments(t)
				.slice(1)
				.some((s) => columnSegs.has(s))
		}))
		.sort(
			(a, b) =>
				Number(b.rootMatch) - Number(a.rootMatch) ||
				a.t.length - b.t.length ||
				a.t.localeCompare(b.t)
		);
	return {
		reference: scored[0]?.t,
		options: [...matches].sort(),
		matched: matches.length > 0
	};
}

/** Intersection de deux ensembles (le plus petit itéré). */
function intersect(a: Set<string>, b: Set<string>): Set<string> {
	const [small, big] = a.size <= b.size ? [a, b] : [b, a];
	const out = new Set<string>();
	for (const v of small) if (big.has(v)) out.add(v);
	return out;
}

/** Tables portant TOUTES les colonnes (intersection des porteurs). */
function tablesContainingAll(
	columns: readonly string[],
	columnCarriers: ReadonlyMap<string, Set<string>>
): string[] {
	if (columns.length === 0) return [];
	let acc: Set<string> | null = null;
	for (const c of columns) {
		const s = columnCarriers.get(c);
		if (s === undefined) return [];
		acc = acc === null ? new Set(s) : intersect(acc, s);
		if (acc.size === 0) return [];
	}
	return acc === null ? [] : [...acc];
}

/** Rang de tri d'un ancrage (plus fiable = plus haut). */
const ANCHOR_RANK: Record<CandidateAnchor, number> = {
	"primary-key": 0,
	name: 1,
	"co-occurrence": 2
};

/**
 * Détecte les candidats de relation d'un schéma sans FK. Trié par impact
 * (nombre de tables porteuses) décroissant, ancrage fiable d'abord.
 */
export function detectRelationCandidates(
	schema: Pick<SchemaModel, "collections">
): RelationCandidate[] {
	const collections = schema.collections;
	const columnCarriers = new Map<string, Set<string>>();
	for (const c of collections) {
		for (const f of c.fields) {
			let set = columnCarriers.get(f.name);
			if (set === undefined) {
				set = new Set<string>();
				columnCarriers.set(f.name, set);
			}
			set.add(c.name);
		}
	}

	const auditMax =
		collections.length >= AUDIT_MIN_TABLES
			? Math.max(MIN_CARRIERS, Math.floor(collections.length * AUDIT_RATIO))
			: Number.POSITIVE_INFINITY;
	// Colonnes déjà « consommées » par une passe plus fiable — jamais
	// re-listées par une passe suivante (pas de doublon composite/colonne).
	const consumed = new Set<string>();
	const candidates: RelationCandidate[] = [];

	// ── Passe 1 : ancrage PK ────────────────────────────────────────────
	// Une table dont la PK (simple ou composite) est portée par d'AUTRES
	// tables → cette table est la référence certaine. Dédupe par jeu de
	// colonnes : plusieurs tables peuvent partager la même PK (rare) →
	// une seule carte, toutes deviennent des options de référence.
	const pkByColumns = new Map<
		string,
		{ columns: string[]; owners: string[]; carriers: string[] }
	>();
	for (const R of collections) {
		const pk = R.primaryKey;
		if (pk === undefined || pk.length === 0) continue;
		const carriers = tablesContainingAll(pk, columnCarriers);
		if (carriers.length < MIN_CARRIERS) continue;
		if (!carriers.some((t) => t !== R.name)) continue;
		const key = [...pk].sort().join(" ");
		const existing = pkByColumns.get(key);
		if (existing === undefined) {
			pkByColumns.set(key, { columns: [...pk], owners: [R.name], carriers });
		} else {
			existing.owners.push(R.name);
		}
	}
	for (const { columns, owners, carriers } of pkByColumns.values()) {
		for (const col of columns) consumed.add(col);
		// Clé que chaque porteur possède en propre (`id` partout, `_id` sous
		// Mongo) : aucune table n'en vise une autre.
		if (carriers.every((t) => owners.includes(t))) continue;
		const token = groupToken(columns);
		const { reference } = pickReference(columns, owners, token);
		candidates.push({
			id: `pk:${columns.join("+")}`,
			columns,
			carriers: [...carriers].sort(),
			suggestedReference: reference ?? owners.slice().sort()[0]!,
			referenceOptions: owners.slice().sort(),
			anchor: "primary-key"
		});
	}

	// Porteurs éligibles aux passes non-ancrées : ni consommés, ni trop rares,
	// ni trop répandus (audit).
	const eligible = new Map<string, Set<string>>();
	for (const [col, carriers] of columnCarriers) {
		if (consumed.has(col)) continue;
		if (carriers.size < MIN_CARRIERS) continue;
		if (carriers.size > auditMax) continue;
		eligible.set(col, carriers);
	}

	// ── Passe 2 : composites par co-occurrence + extension aux sur-ensembles ──
	// Colonnes éligibles partageant EXACTEMENT le même ensemble de porteurs
	// → probable clé composite. On étend ensuite la clé aux colonnes présentes
	// dans AU MOINS toutes ces tables (sur-ensemble strict) : une colonne d'un
	// triplet répartie plus largement (`DIV_CODE_SOURCE` dans 157 ⊇ la paire
	// dans 142) rejoint le composite au lieu de le fragmenter. Les sur-ensembles
	// ne sont PAS consommés — ils gardent leur usage autonome (une même colonne
	// peut être clé de dossier ici et dimension ailleurs) ; la confirmation
	// LR/2 tranchera.
	const bySignature = new Map<string, string[]>();
	for (const [col, carriers] of eligible) {
		const sig = [...carriers].sort().join(" ");
		const group = bySignature.get(sig);
		if (group === undefined) bySignature.set(sig, [col]);
		else group.push(col);
	}
	for (const [sig, exactCols] of bySignature) {
		if (exactCols.length < 2) continue;
		const carriers = sig.split(" ");
		const carrierSet = new Set(carriers);
		const extra: { col: string; size: number }[] = [];
		for (const [col, cset] of eligible) {
			if (exactCols.includes(col)) continue;
			if (cset.size <= carrierSet.size) continue; // sur-ensemble STRICT
			let superset = true;
			for (const t of carrierSet) {
				if (!cset.has(t)) {
					superset = false;
					break;
				}
			}
			if (superset) extra.push({ col, size: cset.size });
		}
		extra.sort((a, b) => a.size - b.size || a.col.localeCompare(b.col));
		const columns = [...exactCols];
		for (const e of extra) {
			if (columns.length >= MAX_COMPOSITE_COLS) break;
			columns.push(e.col);
		}
		for (const col of exactCols) consumed.add(col);
		const sortedColumns = [...columns].sort();
		const token = groupToken(sortedColumns);
		const { reference, options, matched } = pickReference(
			sortedColumns,
			carriers,
			token
		);
		candidates.push({
			id: `co:${sortedColumns.join("+")}`,
			columns: sortedColumns,
			carriers: [...carriers].sort(),
			suggestedReference: reference ?? [...carriers].sort()[0]!,
			referenceOptions: options.length > 0 ? options : [...carriers].sort(),
			anchor: matched ? "name" : "co-occurrence"
		});
	}

	// ── Passe 3 : hubs colonne unique, ancrés par le nom ────────────────
	// Une colonne partagée SANS table-racine homonyme est le plus souvent du
	// bruit (attribut commun sans « propriétaire ») → on exige un vrai match
	// de nom (`matched`), pas un simple repli.
	for (const [col, carriers] of eligible) {
		if (consumed.has(col)) continue;
		const token = prefixToken(col);
		const { reference, options, matched } = pickReference(
			[col],
			[...carriers],
			token
		);
		if (!matched || reference === undefined) continue;
		consumed.add(col);
		candidates.push({
			id: `name:${col}`,
			columns: [col],
			carriers: [...carriers].sort(),
			suggestedReference: reference,
			referenceOptions: options,
			anchor: "name"
		});
	}

	candidates.sort(
		(a, b) =>
			b.carriers.length - a.carriers.length ||
			ANCHOR_RANK[a.anchor] - ANCHOR_RANK[b.anchor] ||
			b.columns.length - a.columns.length ||
			a.id.localeCompare(b.id)
	);
	return candidates;
}

/**
 * Le canvas doit-il proposer l'inférence guidée ? Oui quand la base n'a
 * AUCUNE relation (ni FK ni heuristique) et qu'on a détecté des candidats —
 * exactement le cas d'une base legacy sans FK.
 */
export function shouldOfferInference(schema: SchemaModel): boolean {
	if (schema.relations.length > 0) return false;
	if (schema.collections.length < 2) return false;
	return detectRelationCandidates(schema).length > 0;
}
