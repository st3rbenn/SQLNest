/**
 * Ops applicatives du tunnel — payload clair d'une frame `req` et sa réponse.
 * Contrat unique, partagé par le CLI (qui les exécute), le front et le
 * backend (qui les envoient). Ajouter une op = une entrée ici, un handler
 * côté CLI.
 */

/** Ping applicatif : latence de la base locale et sa version. */
export interface TunnelPingData {
	readonly latencyMs: number;
	readonly serverVersion?: string;
}

/** Colonne d'un résultat `runSnql`. */
export interface TunnelResultColumn {
	readonly name: string;
	readonly type?: string;
	readonly nullable?: boolean;
}

export interface TunnelRunSnqlData {
	readonly columns: readonly TunnelResultColumn[];
	readonly rows: readonly Record<string, unknown>[];
	readonly rowCount: number;
	/** Le statement a écrit (mutation ou DDL) : le front invalide son cache. */
	readonly written: boolean;
}

/**
 * Projet relié à la connexion servie (ADR-037 D2) : ce que le navigateur en
 * sait. Jamais le chemin du projet.
 */
export interface TunnelProjectStatusData {
	readonly linked: boolean;
	readonly orm?: "prisma" | "doctrine" | "sequelize" | "seaorm";
	/** `false` : migration et modèle écrits, base non touchée (ADR-035 point 3). */
	readonly apply?: boolean;
	/** Le dossier du projet existe et l'ORM y est toujours détecté. */
	readonly projectFound?: boolean;
	/** Table d'historique de l'ORM, présente ou non dans la base. */
	readonly historyTable?: { readonly name: string; readonly present: boolean };
}

/**
 * Table des ops : nom → requête (champs en plus de `op`) et données de la
 * réponse. `introspect` rend le `SchemaModel` de `@sqlnest/snql`, que ce
 * paquet n'importe pas.
 */
export interface TunnelOpTable {
	readonly ping: { readonly req: object; readonly data: TunnelPingData };
	readonly introspect: { readonly req: object; readonly data: unknown };
	readonly runSnql: {
		readonly req: { readonly src: string };
		readonly data: TunnelRunSnqlData;
	};
	readonly projectStatus: {
		readonly req: object;
		readonly data: TunnelProjectStatusData;
	};
}

export type TunnelOpName = keyof TunnelOpTable;

/** Requête d'une op, telle qu'elle voyage dans la frame `req`. */
export type TunnelOpOf<K extends TunnelOpName> = { readonly op: K } & TunnelOpTable[K]["req"];

export type TunnelOp = { [K in TunnelOpName]: TunnelOpOf<K> }[TunnelOpName];

/** Données d'une réponse réussie. */
export type TunnelOpData<K extends TunnelOpName> = TunnelOpTable[K]["data"];

/**
 * Réponse d'une op (payload de la frame `res`). Le CLI ajoute à un échec le
 * détail d'une erreur Postgres (`pgError`), validé par le backend qui le lit.
 */
export type TunnelOpResult<D = unknown> =
	| { readonly ok: true; readonly data: D }
	| { readonly ok: false; readonly error: string };
