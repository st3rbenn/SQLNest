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

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
