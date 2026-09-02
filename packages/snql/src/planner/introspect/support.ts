/**
 * Matrice `(kind, engine)` pour l'introspection tier-1 + hints actionables +
 * tables système réservées. La capability `introspect` reste grossière côté
 * `capabilities.ts` (« l'adapter connaît AU MOINS un kind ») — la granularité
 * fine vit ici pour éviter d'exploser la surface Capabilities (6 kinds × 3
 * engines = 18 flags par adapter, casse la doctrine « capability = surface »).
 *
 * Extensible sans refactor : nouveau kind = 1 entry dans SUPPORT + 1 hint
 * optionnel. Nouveau engine = 1 valeur d'`EngineKind` + entries dans les Sets.
 *
 * Testable : la matrice est data, pas un switch — un test balaie
 * `for each kind × for each engine` et vérifie que refus + hint sont cohérents.
 */

import type { IntrospectKind } from "../../parser/ast";

/** Engines connus du planner. Les engines inconnus refusent tout par défaut. */
export type EngineKind = "postgres" | "mongodb" | "kv";

/**
 * Matrice de support par kind côté engine adapter (CLI). Un kind présent dans
 * un Set = l'engine adapter peut l'exécuter directement (mapIntrospect →
 * native → connection.execute). `list-schema-events` a un Set vide car le
 * SQLNest client (frontend) intercepte AVANT le tunnel — le CLI ne route pas
 * vers l'API SQLNest et n'a pas les credentials pour. Si le CLI voit ce kind,
 * c'est un bug de routing client → refus explicite avec hint dev.
 */
export const INTROSPECT_SUPPORT: Readonly<
	Record<IntrospectKind, ReadonlySet<EngineKind>>
> = {
	"list-tables": new Set(["postgres", "mongodb"]),
	"describe-table": new Set(["postgres", "mongodb"]),
	"list-schemas": new Set(["postgres", "mongodb"]),
	"list-indexes": new Set(["postgres", "mongodb"]),
	"list-databases": new Set(["mongodb"]),
	"list-schema-events": new Set(),
	"list-enums": new Set(["postgres", "mongodb"]),
	"describe-enum": new Set(["postgres", "mongodb"])
};

/**
 * Hint actionable par (kind, engine) refusé — pointe vers le remplacement
 * natif quand il existe, ou vers `raw` en dernier recours. Absent = refus
 * générique sans hint. La matrice définit CE qui refuse, le hint dit COMMENT
 * contourner — deux concerns, deux tables.
 */
export const INTROSPECT_HINTS: Readonly<
	Record<IntrospectKind, Partial<Record<EngineKind, string>>>
> = {
	"list-tables": {},
	"describe-table": {},
	"list-schemas": {},
	"list-indexes": {},
	"list-databases": {
		postgres:
			"utilise 'list schemas' pour les namespaces intra-DB"
	},
	// Un hint identique pour tous les engines : c'est un kind routé côté
	// client SQLNest, jamais exécuté par un adapter engine.
	"list-schema-events": {
		postgres:
			"'list schema_events' est routé par le client SQLNest — utilise-le depuis la console web",
		mongodb:
			"'list schema_events' est routé par le client SQLNest — utilise-le depuis la console web",
		kv:
			"'list schema_events' est routé par le client SQLNest — utilise-le depuis la console web"
	},
	"list-enums": {},
	"describe-enum": {}
};

/**
 * Code d'erreur planner canonique par kind. Un code par kind (pas par pair
 * kind×engine) — l'engine vit dans le message. Cohérent avec
 * `planner_upsert_unsupported` etc.
 */
export const INTROSPECT_ERROR_CODES: Readonly<
	Record<IntrospectKind, string>
> = {
	"list-tables": "planner_introspect_tables_unsupported",
	"describe-table": "planner_introspect_describe_table_unsupported",
	"list-schemas": "planner_introspect_schemas_unsupported",
	"list-indexes": "planner_introspect_indexes_unsupported",
	"list-databases": "planner_introspect_databases_unsupported",
	"list-schema-events": "planner_introspect_schema_events_unsupported",
	"list-enums": "planner_introspect_enums_unsupported",
	"describe-enum": "planner_introspect_describe_enum_unsupported"
};

/**
 * Tables système réservées SQLNest. Utilisées comme collection user
 * (`find schema_events`, `add ... into schema_events`) → refus au planner avec
 * hint vers le verbe introspect. Break net choisi contre alias transparent
 * (audit trail = beta interne, coexistence = dette permanente + confusion doc).
 */
export const RESERVED_SYSTEM_TARGETS: ReadonlySet<string> = new Set([
	"schema_events"
]);

/**
 * Tables système en lecture seule. Aujourd'hui = `RESERVED_SYSTEM_TARGETS`
 * (tout ce qui est réservé est readonly par défaut). Séparé pour laisser la
 * porte ouverte à des tables système writable v-next (ex : `_sqlnest_tags`).
 */
export const READONLY_SYSTEM_TARGETS: ReadonlySet<string> = new Set([
	"schema_events"
]);

/**
 * Vrai ssi l'engine supporte le kind. Refuse par défaut si l'engine n'est pas
 * dans la matrice — un adapter inconnu doit passer par le refus explicite
 * plutôt que fallback silencieux.
 */
export function isIntrospectSupported(
	kind: IntrospectKind,
	engine: string
): boolean {
	if (!isKnownEngine(engine)) return false;
	const supported = INTROSPECT_SUPPORT[kind];
	return supported.has(engine);
}

/**
 * Hint actionable pour un refus (kind, engine). Vide si aucun hint défini.
 * Le caller compose le message final : `<refus> — <hint>`.
 */
export function introspectHintFor(
	kind: IntrospectKind,
	engine: string
): string {
	if (!isKnownEngine(engine)) return "";
	return INTROSPECT_HINTS[kind][engine] ?? "";
}

function isKnownEngine(engine: string): engine is EngineKind {
	return engine === "postgres" || engine === "mongodb" || engine === "kv";
}
