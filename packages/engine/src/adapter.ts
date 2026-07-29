import type {
	Capabilities,
	NativeQuery,
	ResultSet,
	SchemaModel
} from "@sqlnest/snql";
import type { PostgresConnectionConfig } from "./config";
import type { MongoConnectionConfig } from "./mongo/config";

/**
 * Config de connexion **résolue**, discriminée par `engine`. C'est ce que
 * consomme {@link EngineAdapter.connect} : le dispatch dynamique se fait sur
 * `config.engine`. S'étend à chaque moteur ajouté.
 */
export type ResolvedEngineConfig =
	| PostgresConnectionConfig
	| MongoConnectionConfig;

/** Résultat d'un `ping` : latence mesurée + version serveur si disponible. */
export interface PingResult {
	readonly latencyMs: number;
	readonly serverVersion?: string;
}

/**
 * Une connexion ouverte à un moteur. Enveloppe un pool sous-jacent ;
 * `close()` libère toutes les ressources.
 */
export interface Connection {
	readonly engine: string;
	/** Vérifie que le moteur répond (aller-retour réseau). Lève si injoignable. */
	ping(): Promise<PingResult>;
	/** Lit la structure de la base → SchemaModel unifié. */
	introspect(): Promise<SchemaModel>;
	/** Exécute une requête native (le pushdown) et renvoie un ResultSet normalisé. */
	execute(query: NativeQuery): Promise<ResultSet>;
	/** Ferme le pool et libère les ressources. Idempotent. */
	close(): Promise<void>;
}

/**
 * Le **contrat** qu'un moteur implémente pour brancher SNQL dessus (couche 1,
 * « Connexion »). Ajouter un moteur = implémenter ce contrat, sans toucher au
 * langage. Voir le vault : `04 - Engines/Engine Adapter Interface`.
 *
 * Slice 5 couvre le cycle de vie de connexion (`connect` → `ping` → `close`).
 * `introspect` (→ SchemaModel) et `execute` (→ ResultSet) arrivent aux slices
 * 6 et 7.
 */
export interface EngineAdapter {
	/** Identifiant stable du moteur : `"postgres"`, `"mongodb"`, … */
	readonly id: string;
	/** Ce que le moteur sait pousser nativement (alimente le planner). */
	readonly capabilities: Capabilities;
	/** Établit et vérifie une connexion à partir d'une config résolue. */
	connect(config: ResolvedEngineConfig): Promise<Connection>;
}
