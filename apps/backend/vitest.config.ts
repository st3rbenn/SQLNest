import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		coverage: {
			// enabled: env.CI === "true",
			provider: "v8",
			exclude: ["dist/**", "src/plugins/**", "*.config.ts", "src/index.ts", "src/app.ts"],
			thresholds: {
				"src/domains/**/*.ts": {
					lines: 0,
				},
				"src/routes/**/*.ts": {
					lines: 0,
				},
			},
		},
	},
});
