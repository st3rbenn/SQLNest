import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		react()
	],
	server: {
		port: 3000
	},
	preview: {
		port: 3000
	},
	build: {
		sourcemap: true
	},
	test: {
		include: ["src/**/*.test.ts?(x)"],
		exclude: ["e2e/**/*", "**/node_modules/**", "**/dist/**"],
		environment: "happy-dom",
		setupFiles: ["./src/test-setup.ts"],
		silent: process.env.CI === "true",
		coverage: {
			enabled: process.env.CI === "true",
			provider: "v8",
			reportsDirectory: "./coverage/unit",
			reporter: ["text", "json", "cobertura"],
			include: ["src/**/*.{ts,tsx}"],
			exclude: [
				"node_modules",
				// Barrels
				"src/**/index.ts",
				// TYPES
				"src/types",
				"src/**/*.type.ts",
				"src/**/types.ts",
				"src/vite-env.d.ts",
				// Not wanted
				"src/generated",
				"src/routeTree.gen.ts",
				"src/mocks",
				"src/test",
				// CSS
				"src/**/*.css.{ts,tsx}",
				// Not wanted
				"src/generated",
				"src/mocks",
				"src/routes",
				"src/test",
				"src/types",
				"src/main.ts",
				"src/routeTree.gen.ts"
			]
		}
	}
});
