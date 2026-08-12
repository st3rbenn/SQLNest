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
 * Comportement NULL dans un contexte d'écriture (mode write : filtres de
 * remove/update dans une négation). Non déclaré → refusé au lower avec
 * `lower_call_null_write`. À muscle plus tard sans breaking change.
 */
export type NullBehavior = "propagate" | "absorb" | "custom";

/** Contexte transmis au renderer par le codegen. Générique — chaque engine en pousse ses invariants. */
export interface RenderContext {
	readonly renderExpr: (expr: unknown) => unknown;
	readonly addParam?: (value: unknown) => string;
	readonly alias?: string | undefined;
}

/** Renderer par engine : reçoit les args (déjà lowered en PlanExpr) + le contexte engine-spécifique. */
export type EngineRenderer = (
	args: readonly unknown[],
	ctx: RenderContext
) => unknown;

/** Kind d'une fonction — pilote comment le codegen la place dans le SQL/pipeline. */
export type FunctionKind = "scalar" | "aggregate" | "window" | "reserved";

/**
 * Une entrée du registre. Un renderer engine absent = fonction non-supportée
 * par ce moteur → détecté au planner via `Capabilities.functions`.
 */
export interface FunctionEntry {
	readonly name: string;
	readonly kind: FunctionKind;
	readonly arity: Arity;
	readonly args?: readonly TypeSpec[];
	readonly writeNullBehavior?: NullBehavior;
	readonly engines: {
		readonly postgres?: EngineRenderer;
		readonly mongodb?: EngineRenderer;
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
	forEngine(engine: "postgres" | "mongodb"): ReadonlySet<string>;
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
	for (const [name, entry] of byName) {
		if (entry.engines.postgres !== undefined) pgNames.add(name);
		if (entry.engines.mongodb !== undefined) mongoNames.add(name);
	}
	const names = new Set(byName.keys());
	return {
		get: (name) => byName.get(name),
		has: (name) => byName.has(name),
		names: () => names,
		forEngine: (engine) => (engine === "postgres" ? pgNames : mongoNames)
	};
}
