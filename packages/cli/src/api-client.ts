/**
 * Client HTTP du CLI vers le backend SQLNest.
 *
 * Encapsule les 4 endpoints du device flow + le mode CI Bearer.
 *
 * ─── Design ───────────────────────────────────────────────────────────
 * `createApiClient(baseUrl)` retourne un objet avec 4 méthodes typées.
 * Le `baseUrl` est injecté pour permettre le test (mock server local)
 * et la configuration de prod (URL bakée au build via esbuild
 * --define:process.env.NODE_ENV, voir cli.ts).
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

export interface HeartbeatResult {
	readonly ok: true;
	readonly connectionId: string;
}

// ─── API client ───────────────────────────────────────────────────────

export interface ApiClient {
	createPairing(
		cliPubkeyEd25519: string,
		cliConnectionName?: string | null,
		dbFingerprint?: string | null,
		dbSchemaChecksum?: string | null
	): Promise<CreatePairingResult>;
	getPairingStatus(code: string): Promise<StatusPairingResult>;
	authenticatePairing(
		code: string,
		signatureHex: string,
		dbFingerprint?: string | null
	): Promise<AuthenticateResult>;
	authenticateWithToken(
		bearerToken: string,
		cliPubkeyEd25519: string,
		deviceName: string,
		cliConnectionName?: string | null,
		dbFingerprint?: string | null
	): Promise<AuthenticateResult>;
	/**
	 * T4/1.5 : ping périodique + backfill des métadonnées DB (fingerprint,
	 * schema checksum) sur une db_connection existante. Contourne le
	 * findResumableTunnel qui skip authenticate. Auth : Bearer tn_...
	 */
	heartbeat(
		tunnelToken: string,
		dbFingerprint?: string | null,
		dbSchemaChecksum?: string | null
	): Promise<HeartbeatResult>;
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
			cliConnectionName: string | null = null,
			dbFingerprint: string | null = null,
			dbSchemaChecksum: string | null = null
		) {
			const body: Record<string, string> = { cliPubkeyEd25519 };
			if (cliConnectionName != null && cliConnectionName !== "") {
				body.cliConnectionName = cliConnectionName;
			}
			// T4/5 : envoie les identifiants DB dès le pair pour que le
			// backend détecte au /approve qu'une db_connection existe déjà
			// pour cette DB (multi-CLI reuse) → auto-fill device_name.
			if (dbFingerprint != null && dbFingerprint !== "") {
				body.dbFingerprint = dbFingerprint;
			}
			if (dbSchemaChecksum != null && dbSchemaChecksum !== "") {
				body.dbSchemaChecksum = dbSchemaChecksum;
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

		async authenticatePairing(
			code: string,
			signatureHex: string,
			dbFingerprint: string | null = null
		) {
			const body: Record<string, string> = { code, signature: signatureHex };
			// T4/1 Step 6 : optionnel — omis si le CLI n'a pas pu ouvrir la DSN
			// à ce moment. Backend backfill au prochain succès.
			if (dbFingerprint != null && dbFingerprint !== "") {
				body.dbFingerprint = dbFingerprint;
			}
			const data = (await jsonPost(
				"/api/tunnels/authenticate",
				body
			)) as AuthenticateResult;
			return data;
		},

		async authenticateWithToken(
			bearerToken: string,
			cliPubkeyEd25519: string,
			deviceName: string,
			cliConnectionName: string | null = null,
			dbFingerprint: string | null = null
		) {
			const body: Record<string, string> = { cliPubkeyEd25519, deviceName };
			if (cliConnectionName != null && cliConnectionName !== "") {
				body.cliConnectionName = cliConnectionName;
			}
			if (dbFingerprint != null && dbFingerprint !== "") {
				body.dbFingerprint = dbFingerprint;
			}
			const data = (await jsonPost("/api/tunnels/authenticate-token", body, {
				authorization: `Bearer ${bearerToken}`
			})) as AuthenticateResult;
			return data;
		},

		async heartbeat(
			tunnelToken: string,
			dbFingerprint: string | null = null,
			dbSchemaChecksum: string | null = null
		) {
			const body: Record<string, string> = {};
			if (dbFingerprint != null && dbFingerprint !== "") {
				body.dbFingerprint = dbFingerprint;
			}
			if (dbSchemaChecksum != null && dbSchemaChecksum !== "") {
				body.dbSchemaChecksum = dbSchemaChecksum;
			}
			const data = (await jsonPost("/api/tunnels/heartbeat", body, {
				authorization: `Bearer ${tunnelToken}`
			})) as HeartbeatResult;
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
