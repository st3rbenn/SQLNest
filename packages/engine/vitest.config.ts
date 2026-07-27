import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	// Résout `@sqlnest/snql` depuis sa source TS (pas de build préalable requis).
	resolve: {
		alias: {
			"@sqlnest/snql": resolve(here, "../snql/src/index.ts")
		}
	},
	test: {
		globals: true,
		environment: "node"
	}
});
