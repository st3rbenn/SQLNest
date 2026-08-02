/**
 * Client fetch natif pour l'endpoint `/api/canvas-state` du backend Fastify.
 *
 * Pas de wrapper openapi-fetch ici : le schema OpenAPI n'a pas encore intégré
 * la route, on prend la voie directe. `credentials: "include"` sur toutes les
 * requêtes pour joindre le cookie de session Better Auth (préfixe `sqlnest.`).
 *
 * Contract miroir de `apps/backend/src/domains/canvas-state/schema.ts` :
 * - GET  ?signature=<sig>  → 200 { payload, updatedAt } | 404 (null) | 401 (throw)
 * - PUT  { signature, payload } → 200 { updatedAt } | 401/500 (throw)
 * - DELETE ?signature=<sig>  → 204 (void) | 401 (throw)
 *
 * ─── Préfixe `/api` ──────────────────────────────────────────────────────
 * Alignement sur la convention `/api/auth/*` (Better Auth) — facilite le
 * routing reverse-proxy production (une seule règle `/api → backend`).
 */

/** Réponse GET côté serveur — payload opaque (Record) + timestamp ISO. */
export interface CanvasStateGetResponse {
	readonly payload: Record<string, unknown>;
	readonly updatedAt: string;
}

/** Réponse PUT — juste le timestamp mis à jour, pour piloter le lastSavedAt. */
export interface CanvasStatePutResponse {
	readonly updatedAt: string;
}

/**
 * Base URL de la route canvas-state, résolue à l'appel (pas au module import) :
 * `window.CONTEXT` est un injecté à runtime par Vite (voir index.html + config),
 * indispo lors du eager import de certains tests si on lit au top-level.
 */
function endpoint(): string {
	return `${window.CONTEXT.apiBaseUrl}/api/canvas-state`;
}

/**
 * Lit l'état canvas serveur pour la signature donnée.
 *
 * Convention retour :
 * - 200 → l'objet parsé
 * - 404 → `null` (pas d'état côté serveur pour ce couple user × signature)
 * - autre erreur (401, 5xx, réseau) → throw pour que l'appelant (useQuery) la
 *   propage en `isError` et retombe en mode offline.
 */
export async function fetchCanvasState(
	signature: string
): Promise<CanvasStateGetResponse | null> {
	const url = `${endpoint()}?signature=${encodeURIComponent(signature)}`;
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
 * en amont. Retourne `updatedAt` pour que l'UI puisse afficher un
 * « sauvegardé il y a X secondes ».
 */
export async function putCanvasState(
	signature: string,
	payload: Record<string, unknown>
): Promise<CanvasStatePutResponse> {
	const res = await fetch(endpoint(), {
		method: "PUT",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ signature, payload })
	});
	if (!res.ok) {
		throw new Error(`canvas-state PUT failed: HTTP ${res.status}`);
	}
	return (await res.json()) as CanvasStatePutResponse;
}

/**
 * Supprime l'état canvas serveur pour la signature donnée.
 *
 * Idempotent côté backend (204 renvoyé même si aucune row n'existait) — on
 * n'a donc pas à distinguer « inexistant » de « supprimé ».
 */
export async function deleteCanvasState(signature: string): Promise<void> {
	const url = `${endpoint()}?signature=${encodeURIComponent(signature)}`;
	const res = await fetch(url, {
		method: "DELETE",
		credentials: "include"
	});
	if (!res.ok) {
		throw new Error(`canvas-state DELETE failed: HTTP ${res.status}`);
	}
}
