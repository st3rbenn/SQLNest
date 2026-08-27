/**
 * Registre unique des divergences sémantiques PG↔Mongo.
 *
 * Une divergence = un comportement où Mongo et Postgres produisent des
 * résultats différents pour la même source SNQL. Certaines sont mitigées par
 * un shim runtime (coût ≤ 1 op, sémantique PG reproductible exactement),
 * d'autres restent documentées et surfacées à l'user via squiggly INFO
 * éditeur. Critère de gouvernance : harmoniser SI coût ≤ 1 opérateur
 * pipeline ET sémantique PG reproductible exactement, sinon documenter.
 *
 * Ce fichier est la source de vérité consommée par :
 *  1. le planner (émission de `plan_semantic_divergence_write` en write context) ;
 *  2. l'UI éditeur (squiggly INFO tooltip inline) ;
 *  3. les release notes générées ;
 *  4. la parity-matrix — whitelist explicite pour les cas où le diff
 *     bit-à-bit est attendu.
 *
 * Chaque entrée = un code stable, un comportement PG, un comportement Mongo,
 * une mitigation (`shim` | `refus` | `warn`), et un test-mirror-id pour lier
 * au sibling test .test.ts. Toute PR qui touche une divergence DOIT mettre à
 * jour cette table + le test correspondant. Sinon CI fail (gate).
 */

export type DivergenceMitigation = "shim" | "refus" | "warn";

export interface DivergenceEntry {
	readonly code: string;
	readonly title: string;
	readonly pgBehavior: string;
	readonly mongoBehavior: string;
	readonly mitigation: DivergenceMitigation;
	/**
	 * Cible du warning INFO — SNQL construct spécifique surfacé à l'user
	 * via squiggly. Ex: `concat` (fonction), `cast(str as json)` (pattern).
	 * `undefined` = warning global sans anchor (release notes seulement).
	 */
	readonly userFacingHint?: string;
	/**
	 * Message actionnable pour le squiggly INFO éditeur. Court, terse,
	 * sans jargon. Cohérent [[feedback-no-ai-slop-labels]].
	 */
	readonly hintMessage?: string;
	readonly testMirrorId?: string;
}

/**
 * Divergences #13-#16 : issues historiques de la parité Mongo. Chacune suit
 * le critère de gouvernance formalisé.
 */
export const DIVERGENCES: readonly DivergenceEntry[] = [
	{
		code: "concat_null_parity",
		title: "#13 — concat(a, b, …) NULL",
		pgBehavior: "PG.CONCAT traite NULL comme '' (absorb)",
		mongoBehavior: "Mongo $concat propage NULL",
		mitigation: "shim",
		userFacingHint: "concat",
		hintMessage: "Mongo propage NULL — shim $ifNull en projection émule PG.CONCAT (parité livrée)",
		testMirrorId: "-concat-null-shim"
	},
	{
		code: "cast_bool_truthy",
		title: "#14 — cast(x as bool)",
		pgBehavior: "PG cast bool : throw sur '0'/''/null, strict SQL",
		mongoBehavior: "Mongo $convert bool : truthy sur any-non-empty string ('0' → true)",
		mitigation: "warn",
		userFacingHint: "cast(_ as bool)",
		hintMessage: "Mongo diverge — '0' string → true, PG throw. Utilise `case { x = 'true' -> true, else -> false }` pour parité"
	},
	{
		code: "cast_date_timestamp_collapse",
		title: "#15 — cast(x as date/timestamp)",
		pgBehavior: "PG distingue date (date-only) vs timestamp (timestamptz)",
		mongoBehavior: "Mongo Date collapse (pas de date-only, timestamp = Date UTC)",
		mitigation: "warn",
		userFacingHint: "cast(_ as date)",
		hintMessage: "BSON Date = timestamp UTC — pas de date-only comme PG. Trunc côté application si besoin"
	},
	{
		// Résolu par ADR-032 (parité 3VL read + write). Le read Mongo est désormais
		// existence-aware comme le write l'était déjà → `!=` exclut v ET null,
		// exactement comme la 3VL de PG. Plus AUCUN squiggly sur `!=` (pas de
		// userFacingHint) : la parité est totale et automatique, l'annoter serait du
		// bruit. Entrée conservée en `shim` pour la gouvernance/release notes.
		code: "not_equal_null_aware",
		title: "#16 — != / not(x=v) — parité 3VL read+write (ADR-032)",
		pgBehavior: "SQL 3VL — != v exclut v ET null",
		mongoBehavior: "$nin:[v,null] en read ET write — exclut v ET null, identique à PG (ADR-032)",
		mitigation: "shim",
		hintMessage:
			"Parité livrée (ADR-032) : `!=` est 3VL-strict en read comme en write, exclut null comme PG — rien à faire"
	},
	// 4 divergences supplémentaires surfacées par l'adversarial
	// (invisibles avant port des 4 blockers, silent-corruption).
	{
		code: "not_in_null_ambiguous",
		title: "#17 — NOT IN NULL 3VL sur subquery matérialisée",
		pgBehavior: "PG 3VL : NOT IN avec null dans la liste → 0 rows (spec SQL)",
		mongoBehavior: "Mongo matérialisé $nin avec null → dépend de l'expr $ne (trap silencieux)",
		mitigation: "refus",
		userFacingHint: "not in (find …)",
		hintMessage: "PG 3VL diverge — filtre les null dans la subquery avec `where <col> is not null`"
	},
	{
		code: "cte_write_snapshot_isolation",
		title: "#18 — CTE + body write snapshot isolation",
		pgBehavior: "PG WITH ... UPDATE atomique dans la même transaction snapshot",
		mongoBehavior: "Mongo materializeLet body write : reads/writes divergent hors session tx",
		mitigation: "refus",
		userFacingHint: "let … ; update|remove",
		hintMessage: "Wrap dans transaction { } — nécessite Mongo 5.0+ RS pour l'atomicité snapshot"
	},
	{
		code: "json_contains_nested",
		title: "#19 — json_contains nested (recursive object)",
		pgBehavior: "PG @> supporte recursive object contains sur jsonb",
		mongoBehavior: "Mongo $setIsSubset ne match que flat arrays de scalaires",
		mitigation: "refus",
		userFacingHint: "json_contains",
		hintMessage: "Mongo ne supporte que flat scalar — nested object contains reporté v3"
	},
	{
		code: "pick_first_last_no_order",
		title: "#20 — pick first/last sans ORDER BY",
		pgBehavior: "PG ordre physique d'insertion (heap scan)",
		mongoBehavior: "Mongo ordre natural non déterministe (dépend du storage engine)",
		mitigation: "refus",
		userFacingHint: "pick first|last",
		hintMessage: "Ordre non déterministe cross-engine — ajoute `sort <col>` explicite"
	}
];

/** Récupère une divergence par son code, `undefined` si absente. */
export function divergenceByCode(
	code: string
): DivergenceEntry | undefined {
	return DIVERGENCES.find((d) => d.code === code);
}

/**
 * Liste les hints attachés à un construct SNQL donné (ex: `concat`, `!=`,
 * `cast(_ as bool)`). Consommé par le squiggly INFO éditeur pour
 * afficher un tooltip in-context sur les usages à risque.
 */
export function hintsForConstruct(
	construct: string
): readonly DivergenceEntry[] {
	return DIVERGENCES.filter((d) => d.userFacingHint === construct);
}
