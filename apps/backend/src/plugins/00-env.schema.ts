import env from "@fastify/env";
import fp from "fastify-plugin";

const schema = {
	type: "object",
	properties: {
		NODE_ENV: {
			type: "string",
			enum: ["development", "production", "test"],
			default: "development"
		},
		FRONTEND_URL: { type: "string", default: "http://localhost:3000" },
		BASE_URL: { type: "string", default: "http://localhost:4000" },
		// ─── Auth (Phase 2 — Better Auth) ────────────────────────────────
		// Secret pour signer les sessions Better Auth (openssl rand -base64 32).
		// - minLength: 32 → openssl rand -base64 32 produit 44 chars, borne saine.
		// - pattern → rejette les placeholders connus (changeme / replace /
		//   placeholder) pour éviter qu'un `.env.example` non édité passe en prod.
		//   Case-insensitive via character class explicite [Cc] etc. — le groupe
		//   inline `(?i:...)` de Perl/PCRE n'est PAS supporté par le regex engine
		//   ECMAScript (V8/Ajv crash au boot avec "Invalid group").
		//   La regex vit dans un JSON schema (pas un littéral JS top-level), donc
		//   hors du champ de la règle Biome useTopLevelRegex.
		AUTH_SECRET: {
			type: "string",
			minLength: 32,
			pattern:
				"^(?!.*[Cc][Hh][Aa][Nn][Gg][Ee][Mm][Ee])(?!.*[Rr][Ee][Pp][Ll][Aa][Cc][Ee])(?!.*[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]).*$"
		},
		// Connexion Postgres applicative (canvas_state + tables auth Better Auth).
		// Le pattern impose un DSN Postgres (postgres:// ou postgresql://) pour
		// détecter au boot une variable pointée sur le mauvais moteur.
		DATABASE_URL: { type: "string", pattern: "^postgres(ql)?://" },
		// OAuth Google — laissés optionnels : si non fournis, le provider Google
		// n'est pas activé côté Better Auth. Utile en dev sans credentials.
		GOOGLE_CLIENT_ID: { type: "string", default: "" },
		GOOGLE_CLIENT_SECRET: { type: "string", default: "" },
		// OAuth GitHub — même logique que Google : optionnels.
		GITHUB_CLIENT_ID: { type: "string", default: "" },
		GITHUB_CLIENT_SECRET: { type: "string", default: "" },
		// Domaine des cookies de session. Vide en dev (localhost). En prod,
		// mettre le domaine parent avec un point (ex: `.sqlnest.io`).
		COOKIE_DOMAIN: { type: "string", default: "" },
		// Origines autorisées par Better Auth (CSV). Parsé côté plugin auth.
		TRUSTED_ORIGINS: { type: "string", default: "http://localhost:3000" }
	},
	required: [
		"NODE_ENV",
		"FRONTEND_URL",
		"BASE_URL",
		"AUTH_SECRET",
		"DATABASE_URL"
	]
};

const options = {
	schema,
	dotenv: true,
	data: process.env
};

export default fp((fastify) => {
	fastify.register(env, options);
});
