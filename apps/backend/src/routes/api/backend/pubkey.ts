import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import z from "zod/v4";

/**
 * Route `GET /api/backend/pubkey` — publie la pubkey Ed25519 du backend.
 *
 * ─── Rôle ────────────────────────────────────────────────────────────
 * Le CLI récupère cette pubkey au premier `sqlnest connect` et la stocke
 * dans `~/.sqlnest/config.toml` (pinning externe). Il l'utilise ensuite
 * pour vérifier les frames signées par le backend dans le flow proxy
 * HTTP → tunnel WS.
 *
 * ─── Public ──────────────────────────────────────────────────────────
 * Pas d'auth. La pubkey est publique par nature — connaître la pubkey
 * ne donne aucun pouvoir, seul le backend a la privkey (dérivée
 * d'AUTH_SECRET, jamais persistée).
 */
const PubkeyResponse = z.object({
	/** Ed25519 pubkey, 64 hex chars. */
	publicKey: z.string(),
	/** Algo — permet une évolution future (ex "ed25519-v2" avec un autre
	 *  HKDF info). Le CLI vérifie que c'est ce qu'il attend. */
	algorithm: z.literal("ed25519")
});
z.globalRegistry.add(PubkeyResponse, { id: "BackendPubkeyResponse" });

export default function backendPubkeyRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();
	instance.get(
		"/pubkey",
		{
			schema: {
				response: { 200: PubkeyResponse }
			}
		},
		async () => ({
			publicKey: fastify.backendKeypair.publicKeyHex,
			algorithm: "ed25519" as const
		})
	);
}
