/**
 * Registre de fonctions SNQL — source unique de vérité pour le call node.
 *
 * Chaque entrée porte : nom canonique, kind (scalar/aggregate/window/reserved),
 * arité (min/max), et un renderer PAR engine embarqué dans l'entrée. Le codegen
 * délègue au renderer plutôt que de maintenir sa propre table de mapping.
 *
 * Sans surface plugin runtime : l'extensibilité passe par `createRegistry(base,
 * overrides)` — pas de mutation globale, pas d'état partagé entre tests.
 *
 * Naming : snake_case lowercase strict. Le lexer normalise avant lookup.
 */

/**
 * Type d'argument déclarable pour un signal early côté lower. `any` est le
 * défaut opt-in : les fonctions évidentes (upper→string, round→number) posent
 * leur contrainte tout de suite ; le reste attend qu'un vrai type-system SNQL
 * émerge (hors scope T2). `string|number|bool|date` couvrent les cas naturels ;
 * `any` = pass-through (aucun check au lower).
 */
export type TypeSpec = "any" | "string" | "number" | "bool" | "date";

/**
 * Comportement NULL dans un contexte d'écriture. Non déclaré → refusé au lower
 * avec `lower_call_null_write`. Déclaré (n'importe quelle valeur) → autorisé.
 *
 *  - `propagate` : arg null → résultat null (95% des fonctions pures scalaires)
 *  - `absorb` : null traité comme neutre (concat PG ignore les null, pas Mongo)
 *  - `custom` : logique dédiée (coalesce renvoie null ssi TOUS args null)
 *  - `deterministic` : 0-arg pur (now, today) — pas de null à propager, safe en write
 */
export type NullBehavior = "propagate" | "absorb" | "custom" | "deterministic";

/** Contexte transmis au renderer par le codegen. Générique — chaque engine en pousse ses invariants. */
export interface RenderContext {
	readonly renderExpr: (expr: unknown) => unknown;
	readonly addParam?: (value: unknown) => string;
	readonly alias?: string | undefined;
	// flags call-level propagés depuis PlanCall.star / .unique.
	// Les renderers scalar existants les ignorent (backward compat total). Les
	// aggregates les lisent pour émettre COUNT(*) / COUNT(DISTINCT x) etc.
	readonly star?: boolean;
	readonly unique?: boolean;
	// rows disponibles pour les renderers KV aggregate (fold).
	// Absent pour les scalar per-row (compat). Les aggregates KV
	// lisent ctx.rows pour évaluer un fold sur toute la collection.
	readonly rows?: readonly Record<string, unknown>[];
	// évaluation d'un PlanExpr par row (KV aggregate). Sépare
	// la responsabilité du fold (renderer KV agg) de l'évaluation scalar
	// (evalValue dans compensate). Absent pour les scalar per-row.
	readonly evalPerRow?: (
		expr: unknown,
		row: Record<string, unknown>
	) => unknown;
	// sort intra-call pour aggregateMulti. Propagé depuis
	// PlanCall.sortKeys. Shape opaque {path, direction} — chaque engine
	// wrap avec son rendu (PG ORDER BY, Mongo $sortArray, KV comparator).
	readonly sortKeys?: readonly {
		readonly path: readonly string[];
		readonly direction: "asc" | "desc";
	}[];
}

/** Renderer par engine : reçoit les args (déjà lowered en PlanExpr) + le contexte engine-spécifique. */
export type EngineRenderer = (
	args: readonly unknown[],
	ctx: RenderContext
) => unknown;

/**
 * Kind d'une fonction — pilote comment le codegen la place dans le SQL/pipeline.
 *  - `scalar` : évalue per-row (upper, coalesce, if…)
 *  - `aggregate` : fold sur un groupe → 1 scalaire (count, sum, min…)
 *  - `aggregateMulti` : fold sur un groupe → 1 collection (array/string/json).
 *    Accepte un `sort <keys>` intra-call pour ordonner les éléments accumulés.
 * `window` : reservé pour (windowCall)
 * `reserved` : nom pris mais pas encore implémenté (hint fourni)
 */
export type FunctionKind =
	| "scalar"
	| "aggregate"
	| "aggregateMulti"
	| "window"
	| "reserved";

/** Nom d'engine supporté (aligné avec `capabilitiesFor`). */
export type EngineName = "postgres" | "mongodb" | "kv";

/**
 * Descripteur opt-in pour hoister un appel de fonction Mongo en dot-notation
 * native (indexable). Sans descripteur → fallback `$expr` (non indexable).
 *
 * Le codegen consomme `toPath(args, alias)` : renvoie le path Mongo si
 * hoistable (arg[0] field + segments literals), sinon `null` → fallback.
 *
 * `kind` détermine la SHAPE du hoist final :
 *  - `'value'` (défaut) : `{path: <literal>}` — pour json_get, extract simple
 *  - `'exists'` : `{path: {$exists: bool}}` — pour json_has_key
 */
export interface MongoMatchHoist {
	readonly toPath: (
		args: readonly unknown[],
		alias?: string
	) => string | null;
	readonly kind?: "value" | "exists";
}

/**
 * Une entrée du registre. Un renderer engine absent = fonction non-supportée
 * par ce moteur → détecté au planner via `Capabilities.functions`.
 *
 * `argEnum[i]` = si présent, l'arg i doit être un **littéral string** membre
 * de cet ensemble. Vérifié au lower avec suggestion Levenshtein sur valeur
 * hors whitelist. Utilisé par les fns date_* pour figer l'unit au lower
 * (`date_part("year", d)`) sans introduire de syntaxe spéciale.
 */
export interface FunctionEntry {
	readonly name: string;
	readonly kind: FunctionKind;
	readonly arity: Arity;
	readonly args?: readonly TypeSpec[];
	readonly argEnum?: readonly (readonly string[] | undefined)[];
	readonly writeNullBehavior?: NullBehavior;
	readonly mongoMatchHoist?: MongoMatchHoist;
	readonly engines: {
		readonly postgres?: EngineRenderer;
		readonly mongodb?: EngineRenderer;
		// dispatch KV pass-through via le registre (au lieu du switch
		// hardcodé dans compensate.ts). Opt-in : tant qu'une fn n'a pas de renderer
		// `kv`, elle reste inconnue du runtime (planner filtre déjà). Migration
		// progressive — les fns héritées gardent leur dispatch inline le temps
		// qu'on les migre. Ajout obligatoire immédiat pour if/nullif/greatest/least
		// (validé par l'utilisateur — pas d'asymétrie planner/runtime tolérée).
		readonly kv?: EngineRenderer;
	};
}

/**
 * Arité unifiée pour les 3 modes (fixe, range, variadic non-borné).
 * - fixe : min === max (ex. upper → 1)
 * - range : min < max finis (ex. round → 1 ou 2)
 * - variadic non borné : max === null (ex. concat → 1..∞, coalesce → 2..∞)
 */
export interface Arity {
	readonly min: number;
	readonly max: number | null;
}

export interface FunctionRegistry {
	get(name: string): FunctionEntry | undefined;
	has(name: string): boolean;
	names(): ReadonlySet<string>;
	forEngine(engine: EngineName): ReadonlySet<string>;
}

/**
 * Construit un registre à partir d'entrées de base + overrides (facilite les
 * tests et un futur mode "custom functions" scopé par team). Sans overrides,
 * c'est l'identity.
 */
export function createRegistry(
	base: readonly FunctionEntry[],
	overrides: readonly FunctionEntry[] = []
): FunctionRegistry {
	const byName = new Map<string, FunctionEntry>();
	for (const entry of base) {
		byName.set(entry.name, entry);
	}
	for (const entry of overrides) {
		byName.set(entry.name, entry);
	}
	const pgNames = new Set<string>();
	const mongoNames = new Set<string>();
	const kvNames = new Set<string>();
	for (const [name, entry] of byName) {
		if (entry.engines.postgres !== undefined) pgNames.add(name);
		if (entry.engines.mongodb !== undefined) mongoNames.add(name);
		if (entry.engines.kv !== undefined) kvNames.add(name);
	}
	const names = new Set(byName.keys());
	return {
		get: (name) => byName.get(name),
		has: (name) => byName.has(name),
		names: () => names,
		forEngine: (engine) => {
			if (engine === "postgres") return pgNames;
			if (engine === "mongodb") return mongoNames;
			return kvNames;
		}
	};
}
