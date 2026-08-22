import type { PreviewSnapshot } from "./useDbConnections";

const API_BASE = window.CONTEXT.apiBaseUrl;

/**
 * PUT snapshot précalculé du dernier rendu de preview pour une
 * `db_connection`.
 *
 * Appelé par le canvas au save (piggyback avec `useCanvasSync`) pour
 * alimenter le fallback rendu de la gallery quand le CLI est offline.
 *
 * Best-effort : on ne bloque JAMAIS le save canvas sur une erreur de
 * snapshot. Un 404 (connection retirée entre-temps) ou un 5xx est
 * catch par le caller et loggé silencieusement.
 */
export async function putPreviewSnapshot(
	connectionId: string,
	snapshot: PreviewSnapshot,
	init?: { keepalive?: boolean; teamSlug?: string | null }
): Promise<void> {
	const url = init?.teamSlug
		? `${API_BASE}/api/teams/${encodeURIComponent(init.teamSlug)}/db-connections/${encodeURIComponent(connectionId)}/preview-snapshot`
		: `${API_BASE}/api/db-connections/${encodeURIComponent(connectionId)}/preview-snapshot`;
	const res = await fetch(url, {
		method: "PUT",
		credentials: "include",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ snapshot }),
		keepalive: init?.keepalive === true
	});
	if (!res.ok) {
		const data = (await res.json().catch(() => ({}))) as { message?: string };
		throw new Error(data.message ?? `HTTP ${res.status}`);
	}
}
