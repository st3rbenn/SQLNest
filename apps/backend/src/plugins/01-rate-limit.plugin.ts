import rateLimit from "@fastify/rate-limit";
import fp from "fastify-plugin";

/**
 * Rate-limit global — protection anti-DoS basique.
 *
 * ─── Bucket key = request.ip (default @fastify/rate-limit) ───────────────
 * On NE fournit PAS de `keyGenerator` custom qui lirait `X-Forwarded-For`
 * — c'est la faille CVE classique du "trust XFF sans allowlist proxy" :
 * n'importe quel client peut rotate le header par requête pour obtenir un
 * bucket unique à chaque appel, ce qui bypass 100% du rate-limit.
 *
 * `request.ip` renvoie l'IP du socket TCP par défaut, non-spoofable. En
 * production derrière un reverse proxy (nginx / Caddy / ALB), il faudra
 * activer `trustProxy` au niveau Fastify AVEC un CIDR explicite (les IPs
 * du proxy) — SEULEMENT à ce moment `request.ip` refléchira XFF.
 *
 *   // À ajouter dans index.ts en prod :
 *   const fastify = Fastify({ trustProxy: '10.0.0.0/8,172.16.0.0/12' })
 *
 * ─── Limite ────────────────────────────────────────────────────────────
 * 100 req / 60s par IP — confortable pour un usage humain (canvas sync
 * toutes les 2s = ~30/min + navigation + get-session). Les endpoints
 * sensibles au brute-force (POST sign-in/sign-up/reset) sont plus
 * strictement limités par un preHandler dédié dans `03-auth.plugin.ts`.
 */
export default fp(
	async (fastify) => {
		await fastify.register(rateLimit, {
			global: true,
			max: 100,
			timeWindow: "1 minute",
			errorResponseBuilder: (_request, context) => ({
				statusCode: 429,
				error: "Too Many Requests",
				message: `Trop de requêtes — réessayez dans ${Math.ceil((context.ttl ?? 60000) / 1000)}s`
			})
		});
	},
	{ name: "01-rate-limit" }
);
