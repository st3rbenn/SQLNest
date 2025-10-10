import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	build: {
		lib: {
			entry: resolve(__dirname, "src/index.ts"),
			name: "snql",
			// the proper extensions will be added
			fileName: "snql",
		},
		rollupOptions: {
			external: ["pino", "ts-mysql-parser"],
			output: {
				globals: {
					pino: "pino",
					"ts-mysql-parser": "tsMysqlParser",
				},
			},
		},
	},
});
