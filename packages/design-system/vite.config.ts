// packages/design-system/vite.config.ts
import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	build: {
		lib: {
			entry: resolve(__dirname, "src/index.ts"),
			name: "SqlnestDesignSystem",
			formats: ["es", "cjs"],
			fileName: (format) => `index.${format === "es" ? "js" : "cjs"}`,
		},
		rollupOptions: {
			external: [
				"react",
				"react-dom",
				"react/jsx-runtime",
				"@mantine/core",
				"@mantine/hooks",
			],
			output: {
				globals: {
					react: "React",
					"react-dom": "ReactDOM",
					"react/jsx-runtime": "jsx",
					"@mantine/core": "MantineCore",
				},
			},
		},
		sourcemap: true,
		emptyOutDir: true,
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
		},
	},
});
