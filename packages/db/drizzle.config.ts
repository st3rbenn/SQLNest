import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Charge `.env` depuis la RACINE du monorepo (deux niveaux au-dessus de
// packages/db/). Sans ça, `process.cwd()` = packages/db/ quand pnpm scope
// le run avec `--filter`, et dotenv ne trouve pas le `.env` racine. On
// utilise `import.meta.url` pour rester correct quelque soit le cwd.
const rootEnv = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	".env"
);
loadEnv({ path: rootEnv, quiet: true });

// Config drizzle-kit — utilisée par les scripts `db:generate`, `db:migrate`,
// `db:push`, `db:studio`. La `DATABASE_URL` est lue depuis l'environnement
// (`.env` racine ci-dessus) — jamais hardcodée.
if (process.env.DATABASE_URL === undefined) {
	throw new Error(
		`DATABASE_URL manquant après lecture de ${rootEnv}. Vérifie que la clé est présente dans .env à la racine du monorepo.`
	);
}

export default defineConfig({
	schema: "./src/schema.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: {
		url: process.env.DATABASE_URL
	},
	// Sortie SQL pretty pour que les migrations soient reviewables en PR.
	verbose: true,
	strict: true
});
