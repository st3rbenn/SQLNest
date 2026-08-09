/**
 * Client HTTP du CLI vers le backend SQLNest.
 *
 * Encapsule les 4 endpoints du device flow + le mode CI Bearer.
 *
 * ─── Design ───────────────────────────────────────────────────────────
 * `createApiClient(baseUrl)` retourne un objet avec 4 méthodes typées.
 * Le `baseUrl` est injecté pour permettre le test (mock server local)
 * et la configuration de prod (URL hardcodée dans cli.ts).
 *
 * Les types de request/response sont dupliqués ici plutôt que réimportés
 * du backend — le CLI est publié séparément sur npm, il ne peut pas
 * dépendre de `@sqlnest/backend`. Le contrat est stable ; si un endpoint
 * évolue, bumper le CLI en même temps.
 *
 * Erreurs :
 *   - Erreur réseau (fetch throw) → propage brut.
 *   - Response !2xx → throw `ApiClientError` avec le statusCode + le
 *     body JSON (pour que le caller puisse discriminer 401 vs 410).
 */

/** Réponse générique du backend en cas d'erreur (`{ message: string }`). */
interface BackendErrorBody {
	readonly message?: string;
}

export class ApiClientError extends Error {
	readonly statusCode: number;
	readonly body: unknown;

	constructor(statusCode: number, body: unknown, url: string) {
		const bodyMsg =
			body != null && typeof body === "object" && "message" in body
				? String((body as BackendErrorBody).message)
				: JSON.stringify(body);
		super(`${url} → HTTP ${statusCode}: ${bodyMsg}`);
		this.name = "ApiClientError";
		this.statusCode = statusCode;
		this.body = body;
	}
}

// ─── Types des réponses backend (dupliqués du contrat Fastify) ────────

export interface CreatePairingResult {
	readonly code: string;
	readonly expiresAt: string;
	readonly pollUrl: string;
}

export type PairingStatus = "pending" | "approved" | "expired" | "consumed";

export interface StatusPairingResult {
	readonly status: PairingStatus;
	readonly deviceName: string | null;
}

export interface AuthenticateResult {
	readonly token: string;
	readonly tunnelId: string;
	readonly connectionId: string;
	readonly expiresAt: string;
}

// ─── API client ───────────────────────────────────────────────────────

export interface ApiClient {
	createPairing(
		cliPubkeyEd25519: string,
		cliConnectionName?: string | null
	): Promise<CreatePairingResult>;
	getPairingStatus(code: string): Promise<StatusPairingResult>;
	authenticatePairing(
		code: string,
		signatureHex: string
	): Promise<AuthenticateResult>;
	authenticateWithToken(
		bearerToken: string,
		cliPubkeyEd25519: string,
		deviceName: string,
		cliConnectionName?: string | null
	): Promise<AuthenticateResult>;
}

/** Impl fetch — injecte `fetch` en option pour permettre le test
 * (mock global `globalThis.fetch`). */
export interface CreateApiClientOptions {
	readonly fetch?: typeof globalThis.fetch;
}

/** Regex utilitaire hissée top-level (règle Biome `useTopLevelRegex`). */
const TRAILING_SLASH_RE = /\/+$/;

export function createApiClient(
	baseUrl: string,
	options: CreateApiClientOptions = {}
): ApiClient {
	const doFetch = options.fetch ?? globalThis.fetch;
	// Retire trailing slash pour éviter `//api/...`.
	const base = baseUrl.replace(TRAILING_SLASH_RE, "");

	async function jsonPost(
		path: string,
		body: unknown,
		headers?: Record<string, string>
	): Promise<unknown> {
		const url = `${base}${path}`;
		const res = await doFetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...headers
			},
			body: JSON.stringify(body)
		});
		return handleResponse(res, url);
	}

	async function jsonGet(path: string): Promise<unknown> {
		const url = `${base}${path}`;
		const res = await doFetch(url, { method: "GET" });
		return handleResponse(res, url);
	}

	return {
		async createPairing(
			cliPubkeyEd25519: string,
			cliConnectionName: string | null = null
		) {
			const body: Record<string, string> = { cliPubkeyEd25519 };
			if (cliConnectionName != null && cliConnectionName !== "") {
				body.cliConnectionName = cliConnectionName;
			}
			const data = (await jsonPost(
				"/api/tunnels/pairings",
				body
			)) as CreatePairingResult;
			return data;
		},

		async getPairingStatus(code: string) {
			// Le backend accepte le code au format `XXXX-XXXX` ou canonique.
			// On URL-encode pour le dash (autorisé mais explicite).
			const data = (await jsonGet(
				`/api/tunnels/pairings/${encodeURIComponent(code)}/status`
			)) as StatusPairingResult;
			return data;
		},

		async authenticatePairing(code: string, signatureHex: string) {
			const data = (await jsonPost("/api/tunnels/authenticate", {
				code,
				signature: signatureHex
			})) as AuthenticateResult;
			return data;
		},

		async authenticateWithToken(
			bearerToken: string,
			cliPubkeyEd25519: string,
			deviceName: string,
			cliConnectionName: string | null = null
		) {
			const body: Record<string, string> = { cliPubkeyEd25519, deviceName };
			if (cliConnectionName != null && cliConnectionName !== "") {
				body.cliConnectionName = cliConnectionName;
			}
			const data = (await jsonPost("/api/tunnels/authenticate-token", body, {
				authorization: `Bearer ${bearerToken}`
			})) as AuthenticateResult;
			return data;
		}
	};
}

async function handleResponse(res: Response, url: string): Promise<unknown> {
	const text = await res.text();
	let parsed: unknown;
	try {
		parsed = text.length > 0 ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}
	if (!res.ok) {
		throw new ApiClientError(res.status, parsed, url);
	}
	return parsed;
}
