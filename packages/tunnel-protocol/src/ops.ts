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

/** Noms que la base ne donne pas (ADR-037 D3), proposés et modifiables dans l'aperçu. */
export interface TunnelSchemaChangeNames {
	/** Modèle d'une nouvelle table. */
	readonly model?: string;
	/** Par FK, `table.colonne` : champ de relation, champ retour, nom de relation. */
	readonly relations?: Readonly<
		Record<
			string,
			{
				readonly field?: string;
				readonly back?: string;
				readonly name?: string;
			}
		>
	>;
}

/** Écart de structure (ADR-037 D5) : attendu d'après le DDL, constaté en base. */
export interface TunnelSchemaDifference {
	readonly target: string;
	readonly subject: string;
	readonly name?: string;
	readonly expected: string;
	readonly actual: string;
}

/**
 * Contrôle après le changement (ADR-037 D3, D5) : `model-database` (modèle ↔
 * base), `history-model` (historique des migrations ↔ modèle, sur une base
 * shadow), `structure` (schéma attendu ↔ introspection).
 */
export interface TunnelSchemaCheck {
	readonly name: "model-database" | "history-model" | "structure";
	/** `true` conforme, `false` écart ; absent quand le contrôle n'a pas tourné. */
	readonly ok?: boolean;
	/** Pourquoi le contrôle n'a pas tourné. */
	readonly skipped?: string;
	/** Écart : le SQL que l'ORM jouerait pour le combler. */
	readonly diff?: string;
	readonly differences?: readonly TunnelSchemaDifference[];
}

/**
 * Changement de schéma écrit dans le projet relié (ADR-037 D7) : chemins
 * relatifs au projet, jamais le contenu des fichiers.
 */
export interface TunnelSchemaChangeData {
	readonly orm: "prisma" | "doctrine" | "sequelize" | "seaorm";
	/** Migration écrite : nom de son dossier, ou de son fichier. */
	readonly migration: string;
	/** Fichiers écrits ou modifiés, relatifs au projet. */
	readonly files: readonly string[];
	/** `false` : base non touchée (projet relié avec `apply = false`). */
	readonly applied: boolean;
	readonly checks: readonly TunnelSchemaCheck[];
	/** Noms retenus, fournis ou déduits. */
	readonly names?: TunnelSchemaChangeNames;
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
	readonly applySchemaChange: {
		readonly req: {
			readonly src: string;
			readonly names?: TunnelSchemaChangeNames;
		};
		readonly data: TunnelSchemaChangeData;
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
