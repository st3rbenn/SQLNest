import type { OrmDetection } from "../../orm/detect";
import type { DbEngine, ParsedConnection } from "../connection-strings";
import type { LocalConnectionUrlRef } from "../local-connections";

/** D'où vient une base découverte. */
export type DiscoveredSource =
	| { readonly kind: "env-file"; readonly file: string; readonly key: string }
	| { readonly kind: "orm-config"; readonly file: string }
	| {
			readonly kind: "compose";
			readonly file: string;
			readonly service: string;
			readonly key: string;
	  };

/** Une base trouvée sur la machine, prête à être testée puis enregistrée. */
export interface DiscoveredDatabase {
	readonly connection: ParsedConnection;
	readonly source: DiscoveredSource;
	/** À enregistrer à la place d'une copie de l'URL (ADR-038 S4). */
	readonly urlFrom?: LocalConnectionUrlRef;
	/** ORM du projet qui lit cette base. */
	readonly orm?: OrmDetection;
	/** Serveur Docker qui la sert (même port de la machine), en cours ou arrêté. */
	readonly server?: DiscoveredServer;
}

/** Un serveur (conteneur, service compose) dont les bases se listent en direct. */
export interface DiscoveredServer {
	readonly engine: DbEngine;
	/** Nom du conteneur, ou du service compose jamais créé. */
	readonly name: string;
	readonly image: string;
	readonly host: string;
	readonly port: number;
	readonly user: string | undefined;
	/** Lu dans l'environnement du conteneur ; absent → demandé. */
	readonly password: string | undefined;
	/** Aucun mot de passe attendu (`trust`, Mongo sans utilisateur). */
	readonly passwordless: boolean;
	/** Base où se connecter pour lister les autres. */
	readonly maintenanceDatabase: string;
	/** Base créée avec le conteneur (`POSTGRES_DB`…). */
	readonly defaultDatabase: string | undefined;
	readonly params: Readonly<Record<string, string>>;
	readonly running: boolean;
	/** Conteneur existant, en cours ou arrêté ; absent : service compose jamais créé. */
	readonly container?: string;
	/** `dir` : dossier du projet compose, d'où le démarrer. */
	readonly compose?: {
		readonly project: string;
		readonly service: string;
		readonly dir?: string;
	};
}

/** Un ORM trouvé dont la base n'a pas pu être lue. */
export interface UnresolvedOrm {
	readonly orm: OrmDetection;
	readonly reason: string;
}

export interface Discovery {
	/** Racine du projet courant, absente hors projet. */
	readonly root: string | undefined;
	readonly databases: readonly DiscoveredDatabase[];
	/** Serveurs du projet : ses services compose, les conteneurs lancés depuis lui. */
	readonly projectServers: readonly DiscoveredServer[];
	/** Autres conteneurs de bases, ceux en cours d'abord. */
	readonly servers: readonly DiscoveredServer[];
	readonly unresolved: readonly UnresolvedOrm[];
}
