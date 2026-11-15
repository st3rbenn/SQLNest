/**
 * Application d'un changement (ADR-039 D5) : en mode direct par `runSnql`,
 * comme la console ; en mode migrations par `applySchemaChange` (migration,
 * modèle, contrôles). Un échec rend le message de l'outil ou de la base.
 */

import type {
	TunnelSchemaChangeData,
	TunnelSchemaChangeNames
} from "@sqlnest/tunnel-protocol";
import { runQueryRequest } from "../../query/useRunQuery";

const API_BASE = window.CONTEXT.apiBaseUrl;

export type ChangeOutcome =
	| { readonly ok: true; readonly mode: "direct" }
	| {
			readonly ok: true;
			readonly mode: "migrations";
			readonly result: TunnelSchemaChangeData;
	  }
	| { readonly ok: false; readonly message: string };

export interface ApplyChangeInput {
	readonly teamSlug: string;
	readonly connectionId: string;
	readonly mode: "direct" | "migrations";
	readonly source: string;
	readonly names?: TunnelSchemaChangeNames;
}

export async function applyChange(
	input: ApplyChangeInput
): Promise<ChangeOutcome> {
	if (input.mode === "direct") {
		try {
			await runQueryRequest({
				teamSlug: input.teamSlug,
				connectionId: input.connectionId,
				source: input.source
			});
			return { ok: true, mode: "direct" };
		} catch (err) {
			return { ok: false, message: messageOf(err) };
		}
	}
	const url = `${API_BASE}/api/teams/${encodeURIComponent(input.teamSlug)}/db-connections/${encodeURIComponent(input.connectionId)}/schema-change`;
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			credentials: "include",
			body: JSON.stringify({
				source: input.source,
				...(input.names !== undefined ? { names: input.names } : {})
			})
		});
		const data = (await res.json().catch(() => ({}))) as
			| TunnelSchemaChangeData
			| { message?: string };
		if (!res.ok) {
			return {
				ok: false,
				message:
					("message" in data ? data.message : undefined) ??
					`Changement refusé (HTTP ${res.status})`
			};
		}
		return {
			ok: true,
			mode: "migrations",
			result: data as TunnelSchemaChangeData
		};
	} catch (err) {
		return { ok: false, message: messageOf(err) };
	}
}

/**
 * Noms que le changement prendrait dans le modèle du projet relié (ADR-039
 * D3) : champ de relation, champ retour, modèle. Rien n'est écrit.
 */
export async function fetchChangeNames(input: {
	readonly teamSlug: string;
	readonly connectionId: string;
	readonly source: string;
}): Promise<TunnelSchemaChangeNames | null> {
	const url = `${API_BASE}/api/teams/${encodeURIComponent(input.teamSlug)}/db-connections/${encodeURIComponent(input.connectionId)}/schema-change/preview`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		credentials: "include",
		body: JSON.stringify({ source: input.source })
	});
	const data = (await res.json().catch(() => ({}))) as {
		names?: TunnelSchemaChangeNames;
		message?: string;
	};
	if (!res.ok) {
		throw new Error(data.message ?? `Aperçu refusé (HTTP ${res.status})`);
	}
	return data.names ?? null;
}

/** Les noms saisis, sans les champs laissés vides ; `undefined` : aucun. */
export function typedNames(
	names: TunnelSchemaChangeNames
): TunnelSchemaChangeNames | undefined {
	const filled = (value: string | undefined): value is string =>
		value !== undefined && value.trim() !== "";
	const relations = Object.fromEntries(
		Object.entries(names.relations ?? {}).flatMap(([key, r]) => {
			const kept = {
				...(filled(r.field) ? { field: r.field.trim() } : {}),
				...(filled(r.back) ? { back: r.back.trim() } : {}),
				...(filled(r.name) ? { name: r.name.trim() } : {})
			};
			return Object.keys(kept).length > 0 ? [[key, kept]] : [];
		})
	);
	const out = {
		...(filled(names.model) ? { model: names.model.trim() } : {}),
		...(Object.keys(relations).length > 0 ? { relations } : {})
	};
	return Object.keys(out).length > 0 ? out : undefined;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
