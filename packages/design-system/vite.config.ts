// packages/design-system/vite.config.ts

import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	build: {
		lib: {
			entry: resolve(__dirname, "src/index.ts"),
			name: "SqlnestDesignSystem",
			formats: ["es", "cjs"],
			fileName: (format) => `index.${format === "es" ? "js" : "cjs"}`,
			cssFileName: "design-system",
		},
		rollupOptions: {
			external: [
				"react",
				"react-dom",
				"react/jsx-runtime",
				"@mantine/core",
				"@mantine/hooks",
				"@mantine/notifications",
				"@mantine/spotlight",
				"@tabler/icons-react",
			],
			output: {
				globals: {
					react: "React",
					"react-dom": "ReactDOM",
					"react/jsx-runtime": "jsx",
					"@mantine/core": "MantineCore",
					"@mantine/hooks": "MantineHooks",
					"@mantine/notifications": "MantineNotifications",
					"@mantine/spotlight": "MantineSpotlight",
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
