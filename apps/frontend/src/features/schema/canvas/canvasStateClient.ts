/**
 * Client fetch pour l'endpoint team-scoped `/api/teams/:slug/canvas-state`.
 *
 * Pas de wrapper openapi-fetch : la route n'est pas dans le schema OpenAPI.
 * `credentials: "include"` sur toutes les requêtes pour joindre le cookie
 * de session Better Auth (préfixe `sqlnest.`).
 *
 * Contract miroir de `apps/backend/src/routes/api/teams/canvas-state.ts` :
 * - GET  ?connectionId=<uuid> → 200 { payload, updatedAt } | 404 (null) | 401 (throw)
 * - PUT  { connectionId, payload } → 200 { updatedAt } | 401/500 (throw)
 * - DELETE ?connectionId=<uuid> → 204 (void) | 401 (throw)
 */

export interface CanvasStateGetResponse {
	readonly payload: Record<string, unknown>;
	readonly updatedAt: string;
}

export interface CanvasStatePutResponse {
	readonly updatedAt: string;
}

/**
 * Base URL résolue à l'appel — `window.CONTEXT` est injecté à runtime par
 * Vite (voir index.html), donc indispo à certains eager imports.
 */
function endpoint(teamSlug: string): string {
	return `${window.CONTEXT.apiBaseUrl}/api/teams/${encodeURIComponent(teamSlug)}/canvas-state`;
}

/**
 * Lit l'état canvas serveur pour la connection donnée.
 *
 * Convention retour :
 * - 200 → l'objet parsé
 * - 404 → `null` (pas d'état côté serveur pour ce couple user × connection)
 * - autre erreur (401, 5xx, réseau) → throw pour que l'appelant (useQuery) la
 *   propage en `isError` et retombe en mode offline.
 */
export async function fetchCanvasState(
	connectionId: string,
	teamSlug: string
): Promise<CanvasStateGetResponse | null> {
	const url = `${endpoint(teamSlug)}?connectionId=${encodeURIComponent(connectionId)}`;
	const res = await fetch(url, {
		method: "GET",
		credentials: "include"
	});
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(`canvas-state GET failed: HTTP ${res.status}`);
	}
	return (await res.json()) as CanvasStateGetResponse;
}

/**
 * Pousse l'état canvas au serveur (upsert atomique côté backend).
 *
 * Le payload est envoyé opaque — sérialisation gérée par `canvasPayload.ts`
 * en amont. Retourne `updatedAt` pour l'UI `sauvegardé il y a X secondes`.
 */
export async function putCanvasState(
	connectionId: string,
	payload: Record<string, unknown>,
	teamSlug: string
): Promise<CanvasStatePutResponse> {
	const res = await fetch(endpoint(teamSlug), {
		method: "PUT",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ connectionId, payload })
	});
	if (!res.ok) {
		throw new Error(`canvas-state PUT failed: HTTP ${res.status}`);
	}
	return (await res.json()) as CanvasStatePutResponse;
}

/**
 * Supprime l'état canvas serveur pour la connection donnée.
 *
 * Idempotent côté backend (204 renvoyé même si aucune row n'existait) — on
 * n'a donc pas à distinguer « inexistant » de « supprimé ».
 */
export async function deleteCanvasState(
	connectionId: string,
	teamSlug: string
): Promise<void> {
	const url = `${endpoint(teamSlug)}?connectionId=${encodeURIComponent(connectionId)}`;
	const res = await fetch(url, {
		method: "DELETE",
		credentials: "include"
	});
	if (!res.ok) {
		throw new Error(`canvas-state DELETE failed: HTTP ${res.status}`);
	}
}
