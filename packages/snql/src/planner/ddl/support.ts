/**
 * Matrice `(DDLKind, engine)` pour DDL Tier-2 — [[ADR-029]] D5. Miroir strict
 * du pattern `INTROSPECT_SUPPORT` d'ADR-026 pour éviter deux code paths
 * distincts. La capability `ddl` reste grossière côté `capabilities.ts`
 * (« l'adapter connaît AU MOINS un kind DDL ») — la granularité fine vit ici.
 *
 * Extensible sans refactor : nouveau kind = 1 entry dans SUPPORT + 1 code
 * d'erreur. Nouveau engine = 1 valeur d'`EngineKind` + entries dans les cells.
 *
 * Testable : la matrice est data, pas un switch — un test balaie
 * `pour chaque kind × pour chaque engine` et vérifie que refus + hint sont
 * cohérents.
 *
 * V1 (DDL/1) couvre uniquement `create-table` — les autres cellules sont
 * inline mais leur codegen adapter arrive DDL/2..DDL/4.
 */

import type { DDLKind } from "../../parser/ast";
import type { EngineKind } from "../introspect/support";

/**
 * Cellule d'une pair (kind, engine). `mode` = comment le verbe est exécuté ;
 * `locks` = ce que l'engine acquiert quand il l'exécute (utilisé par diagnostics
 * D5 non-bloquants pour surfacer les impacts prod à l'user via explain UI).
 * Toutes les cellules sont `native` OU `compensated` — aucun `refused` pour un
 * gap engine (thèse Hard Version + PA/1-8). Les refus admis (invariance
 * sémantique, contrainte scale runtime, verrous engine natifs) sont émis au
 * niveau planner/runtime par les asserts spécifiques, pas via la matrice.
 */
export interface LockDescriptor {
	readonly mode: "shared" | "exclusive" | "metadata";
	readonly scope: "row" | "table" | "database";
}

export interface DDLSupportCell {
	readonly mode: "native" | "compensated";
	readonly locks: readonly LockDescriptor[];
}

const METADATA_DATABASE: LockDescriptor = {
	mode: "metadata",
	scope: "database"
};
const EXCLUSIVE_TABLE: LockDescriptor = {
	mode: "exclusive",
	scope: "table"
};

/**
 * Matrice complète des 7 DDLKinds × 3 engines. Cellules NON encore
 * implémentées côté codegen (DDL/2..DDL/4) restent déclarées pour que
 * `assertDDLSupported` échoue au bon endroit dès qu'une source les cible.
 */
export const DDL_SUPPORT: Readonly<
	Record<DDLKind, Record<EngineKind, DDLSupportCell>>
> = {
	"create-table": {
		postgres: { mode: "native", locks: [EXCLUSIVE_TABLE] },
		mongodb: { mode: "compensated", locks: [METADATA_DATABASE] },
		kv: { mode: "compensated", locks: [] }
	},
	"drop-table": {
		postgres: { mode: "native", locks: [EXCLUSIVE_TABLE] },
		mongodb: { mode: "compensated", locks: [METADATA_DATABASE] },
		kv: { mode: "compensated", locks: [] }
	},
	"add-column": {
		postgres: { mode: "native", locks: [EXCLUSIVE_TABLE] },
		mongodb: { mode: "compensated", locks: [METADATA_DATABASE] },
		kv: { mode: "compensated", locks: [] }
	},
	"drop-column": {
		postgres: { mode: "native", locks: [EXCLUSIVE_TABLE] },
		mongodb: { mode: "compensated", locks: [METADATA_DATABASE] },
		kv: { mode: "compensated", locks: [] }
	},
	"add-index": {
		postgres: { mode: "native", locks: [] },
		mongodb: { mode: "native", locks: [METADATA_DATABASE] },
		kv: { mode: "compensated", locks: [] }
	},
	"add-unique-index": {
		postgres: { mode: "native", locks: [] },
		mongodb: { mode: "native", locks: [METADATA_DATABASE] },
		kv: { mode: "compensated", locks: [] }
	},
	"drop-index": {
		postgres: { mode: "native", locks: [] },
		mongodb: { mode: "native", locks: [METADATA_DATABASE] },
		kv: { mode: "compensated", locks: [] }
	},
	"create-enum": {
		postgres: { mode: "native", locks: [METADATA_DATABASE] },
		mongodb: { mode: "compensated", locks: [METADATA_DATABASE] },
		kv: { mode: "compensated", locks: [] }
	}
};

/**
 * Code d'erreur planner canonique par kind. Un code par kind (pas par pair
 * kind×engine) — l'engine vit dans le message. Cohérent avec
 * `planner_introspect_<kind>_unsupported` (ADR-026).
 */
export const DDL_ERROR_CODES: Readonly<Record<DDLKind, string>> = {
	"create-table": "planner_ddl_create_table_unsupported",
	"drop-table": "planner_ddl_drop_table_unsupported",
	"add-column": "planner_ddl_add_column_unsupported",
	"drop-column": "planner_ddl_drop_column_unsupported",
	"add-index": "planner_ddl_add_index_unsupported",
	"add-unique-index": "planner_ddl_add_unique_index_unsupported",
	"drop-index": "planner_ddl_drop_index_unsupported",
	"create-enum": "planner_ddl_create_enum_unsupported"
};

/**
 * Vrai ssi l'engine supporte le kind (natif OU compensé). Un adapter engine
 * inconnu (pas dans EngineKind) refuse tout par défaut. La matrice ne renvoie
 * jamais `refused` — la doctrine Hard Version + PA/1-8 impose que chaque
 * cellule soit soit `native` soit `compensated`.
 */
export function isDDLSupported(kind: DDLKind, engine: string): boolean {
	if (!isKnownEngine(engine)) return false;
	return DDL_SUPPORT[kind][engine] !== undefined;
}

/**
 * Cell descriptor pour un pair (kind, engine). Consommé par le planner pour
 * choisir le codegen path (native vs compensated) et par l'explain UI pour
 * surfacer les impacts (locks acquis). Renvoie `null` si l'engine n'est pas
 * connu ou si le kind n'a pas de cellule.
 */
export function ddlSupportCell(
	kind: DDLKind,
	engine: string
): DDLSupportCell | null {
	if (!isKnownEngine(engine)) return null;
	return DDL_SUPPORT[kind][engine];
}

function isKnownEngine(engine: string): engine is EngineKind {
	return engine === "postgres" || engine === "mongodb" || engine === "kv";
}
