import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// Les fichiers `.int.test.ts` (auth, canvas-state) TRUNCATE la même
		// base Postgres — en parallèle, ils se marchent dessus (FK violations,
		// duplicate emails). Sérialiser l'exécution par FICHIER est la
		// solution la plus simple : la parallélisation intra-fichier reste
		// active, mais deux fichiers `.int.test.ts` ne tournent jamais en
		// même temps. Coût perf négligeable (2 fichiers int, <1s chacun).
		fileParallelism: false,
		coverage: {
			// enabled: env.CI === "true",
			provider: "v8",
			exclude: [
				"dist/**",
				"src/plugins/**",
				"*.config.ts",
				"src/index.ts",
				"src/app.ts"
			],
			thresholds: {
				"src/domains/**/*.ts": {
					lines: 0
				},
				"src/routes/**/*.ts": {
					lines: 0
				}
			}
		}
	}
});
