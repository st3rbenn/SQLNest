/**
 * Mode d'édition du schéma (ADR-039 D1), déduit de la base et du CLI :
 * migrations quand un projet est relié, bloqué quand un ORM tient
 * l'historique de la base sans projet relié, direct sinon.
 */

import {
	ORM_HISTORY_TABLES,
	ORM_NAMES,
	type OrmName,
	type TunnelProjectStatusData
} from "@sqlnest/tunnel-protocol";
import type { SchemaModel } from "../schema-model";

export type EditMode =
	| { readonly kind: "direct" }
	| {
			readonly kind: "migrations";
			readonly orm: OrmName;
			/** `false` : migration et modèle écrits, base non touchée. */
			readonly apply: boolean;
	  }
	| {
			readonly kind: "blocked";
			readonly orm: OrmName;
			/** `unlinked` : aucun projet relié ; `project-missing` : son dossier a disparu. */
			readonly reason: "unlinked" | "project-missing";
			/** Nom de la connexion côté CLI, pour la commande qui relie le projet. */
			readonly connection?: string;
	  }
	/** Statut du projet pas encore lu. */
	| { readonly kind: "pending" }
	/** Statut illisible (CLI hors ligne…) : édition fermée. */
	| { readonly kind: "unavailable"; readonly message: string };

/** ORM dont la table d'historique figure dans le schéma (casse ignorée). */
export function managingOrm(schema: SchemaModel): OrmName | undefined {
	const names = new Set(schema.collections.map((c) => c.name.toLowerCase()));
	return ORM_NAMES.find((orm) =>
		names.has(ORM_HISTORY_TABLES[orm].toLowerCase())
	);
}

export function editModeOf(
	schema: SchemaModel,
	status:
		| { readonly data: TunnelProjectStatusData }
		| { readonly error: string }
		| undefined
): EditMode {
	if (status === undefined) return { kind: "pending" };
	if ("error" in status) return { kind: "unavailable", message: status.error };
	const { data } = status;
	const connection =
		data.connection !== undefined ? { connection: data.connection } : {};
	if (data.linked && data.orm !== undefined) {
		return data.projectFound === false
			? {
					kind: "blocked",
					orm: data.orm,
					reason: "project-missing",
					...connection
				}
			: { kind: "migrations", orm: data.orm, apply: data.apply ?? true };
	}
	const orm = managingOrm(schema);
	return orm !== undefined
		? { kind: "blocked", orm, reason: "unlinked", ...connection }
		: { kind: "direct" };
}

/** Un changement peut partir dans ce mode. */
export function canApply(mode: EditMode): boolean {
	return mode.kind === "direct" || mode.kind === "migrations";
}
