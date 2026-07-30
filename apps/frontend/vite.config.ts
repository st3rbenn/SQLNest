import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vitest/config";

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		react()
	],
	resolve: {
		alias: {
			"@sqlnest/design-system": resolve(
				__dirname,
				"../../packages/design-system/src/index.ts"
			)
		}
	},
	server: {
		port: Number(process.env.PORT ?? 3000),
		strictPort: false
	},
	preview: {
		port: Number(process.env.PORT ?? 3000),
		strictPort: false
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
