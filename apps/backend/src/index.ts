// ─── Chargement du .env RACINE (AVANT tout import qui lit process.env) ────
// Les plugins autoloadés (02-db, 03-auth…) évaluent leur `process.env.X` à
// l'import — on doit donc peupler process.env AVANT que `./app` soit
// importé. Même pattern que `packages/db/drizzle.config.ts`.
//
// `import.meta.url` = .../apps/backend/src/index.ts → 3 niveaux au-dessus
// pour atteindre la racine monorepo :
//   src/ → apps/backend/ → apps/ → root/
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const rootEnv = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	".env"
);
loadEnv({ path: rootEnv, quiet: true });

// ─── Imports Fastify + plugins (APRÈS loadEnv) ────────────────────────────
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import defaultRequestContext from "@fastify/request-context";
import Fastify from "fastify";
import {
	serializerCompiler,
	validatorCompiler
} from "fastify-type-provider-zod";
import { app } from "./app";

const fastify = Fastify({
	logger: {
		transport: {
			target: "pino-pretty",
			options: {
				colorize: true
			}
		}
	}
});

// ─── Cookie parser AVANT CORS ─────────────────────────────────────────────
// @fastify/cookie parse/écrit les cookies via `request.cookies` / `reply.
// cookie()`. Better Auth ne s'en sert pas directement (il forge ses propres
// Set-Cookie), mais l'installer d'abord garantit que d'autres middlewares
// et le catch-all `/api/auth/*` (qui forwardent des headers Set-Cookie
// multiples) cohabitent proprement dans la chaîne.
fastify.register(cookie);

// ─── CORS ──────────────────────────────────────────────────────────────────
// Origins alignés sur TRUSTED_ORIGINS (env) — la même liste que celle passée
// à Better Auth. `credentials: true` obligatoire pour que le browser envoie
// le cookie de session en cross-origin (frontend Vite localhost:3000 →
// backend Fastify localhost:4000).
//
// PATCH ajouté au preflight — les futures routes canvas utilisent PATCH.
const trustedOrigins = (process.env.TRUSTED_ORIGINS ?? "http://localhost:3000")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

fastify.register(cors, {
	origin: trustedOrigins,
	credentials: true,
	methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
});

fastify.register(defaultRequestContext);

// Zod schemas conversion — s'applique aux routes qui font `withTypeProvider
// <ZodTypeProvider>()`. La route catch-all Better Auth ne l'utilise pas
// (voir 03-auth.plugin.ts).
fastify.setValidatorCompiler(validatorCompiler);
fastify.setSerializerCompiler(serializerCompiler);

fastify.register(app);

const start = async () => {
	try {
		await fastify.listen({ host: "0.0.0.0", port: 4000 });
	} catch (err: unknown) {
		fastify.log.error(err);
		process.exit(1);
	}
};

// ─── Graceful shutdown ─────────────────────────────────────────────────────
// SIGTERM (envoyé par Docker/Kubernetes en fin de vie) et SIGINT (Ctrl+C
// en dev) déclenchent un close propre — laisse le hook `onClose` du plugin
// 02-db fermer le pool Postgres, et Better Auth flusher ses opérations en
// vol. Sans ça : connexions leakées + réponses tronquées.
const shutdown = async (signal: NodeJS.Signals) => {
	fastify.log.info({ signal }, "shutdown initiated");
	try {
		await fastify.close();
		process.exit(0);
	} catch (err) {
		fastify.log.error(err, "error during shutdown");
		process.exit(1);
	}
};

process.on("SIGTERM", () => {
	void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
	void shutdown("SIGINT");
});

start();
