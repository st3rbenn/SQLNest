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
	/**
	 * Sprint T3/1 : namespace runtime — PG schema (search_path), Mongo DB
	 * name. Utilisé par le codegen d'introspection (`list tables` filtre par
	 * ce namespace). Absent = engine sans notion de namespace.
	 */
	readonly namespace?: string;
	/** Vérifie que le moteur répond (aller-retour réseau). Lève si injoignable. */
	ping(): Promise<PingResult>;
	/** Lit la structure de la base → SchemaModel unifié. */
	introspect(): Promise<SchemaModel>;
	/** Exécute une requête native (le pushdown) et renvoie un ResultSet normalisé. */
	execute(query: NativeQuery): Promise<ResultSet>;
	/**
	 * Sprint T4/1 : identifiant opaque **stable** de l'instance DB, indépendant
	 * du device qui s'y connecte. Le backend l'utilise pour ré-associer un
	 * même canvas d'un Mac vers un Windows (ou après un revoke/re-add local).
	 *
	 * Contract : deux CLI qui pointent la MÊME instance DB (même serveur,
	 * même database) retournent le MÊME string. Deux instances distinctes
	 * retournent des strings différents.
	 *
	 * Format : `<engine>:<opaque>` — ex `pg:7331234...`, `mongo:a1b2c3...`.
	 * Le préfixe évite les collisions cross-engine hypothétiques.
	 */
	fingerprint(): Promise<string>;
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
