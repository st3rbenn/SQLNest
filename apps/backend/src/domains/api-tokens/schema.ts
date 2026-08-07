/**
 * Schémas Zod des routes `/api/api-tokens/*`. Séparé du domain pour être
 * partagé entre routes et tests. Convention identifiants : `ApiTokenXxx`.
 */

import z from "zod/v4";

// ─── POST /api/api-tokens ─────────────────────────────────────────────
// Body : un nom humain (`GitHub Actions`, `Local CI`) — servira à
// distinguer les tokens dans le dashboard. Unique par user parmi les
// tokens ACTIFS (index partiel `api_token_user_name_active_unique`).

export const CreateApiTokenBody = z.object({
	name: z
		.string()
		.trim()
		.min(1, "Le nom est requis")
		.max(80, "Nom trop long (max 80)")
});
z.globalRegistry.add(CreateApiTokenBody, { id: "CreateApiTokenBody" });
export type CreateApiTokenBodyT = z.infer<typeof CreateApiTokenBody>;

/** Réponse à la création — inclut le clair `token`, one-shot. Le
 * dashboard DOIT afficher un warning "ce token ne sera plus jamais
 * visible" et proposer un copy-to-clipboard immédiat. */
export const CreateApiTokenResponse = z.object({
	id: z.string(),
	name: z.string(),
	/** Ex `sn_1a2b3` — sert de rappel visuel dans la liste ensuite. */
	prefix: z.string(),
	/** Clair one-shot. Ne repasse plus par le backend après cette
	 *  réponse — impossible à recover. */
	token: z.string(),
	createdAt: z.string()
});
z.globalRegistry.add(CreateApiTokenResponse, { id: "CreateApiTokenResponse" });
export type CreateApiTokenResponseT = z.infer<typeof CreateApiTokenResponse>;

// ─── GET /api/api-tokens ──────────────────────────────────────────────
// Liste les tokens du user connecté (tous statuts). Filtrable par `active`
// dans une version ultérieure — MVP renvoie tout, l'UI cache les révoqués.

export const ListApiTokensResponse = z.object({
	tokens: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			prefix: z.string(),
			createdAt: z.string(),
			lastUsedAt: z.string().nullable(),
			revokedAt: z.string().nullable()
		})
	)
});
z.globalRegistry.add(ListApiTokensResponse, { id: "ListApiTokensResponse" });
export type ListApiTokensResponseT = z.infer<typeof ListApiTokensResponse>;

// ─── DELETE /api/api-tokens/:id ───────────────────────────────────────
// Soft-revoke : `revoked_at = now`. On garde la row pour l'audit
// (dashboard "tokens révoqués"). Le CLI qui présenterait ce token
// verrait un 401 (WHERE `revoked_at IS NULL`).

export const ApiTokenIdParams = z.object({
	id: z.uuid("`id` doit être un uuid")
});
z.globalRegistry.add(ApiTokenIdParams, { id: "ApiTokenIdParams" });
export type ApiTokenIdParamsT = z.infer<typeof ApiTokenIdParams>;

// ─── Erreurs partagées ────────────────────────────────────────────────
export const ApiTokensErrorResponse = z.object({ message: z.string() });
z.globalRegistry.add(ApiTokensErrorResponse, { id: "ApiTokensErrorResponse" });
