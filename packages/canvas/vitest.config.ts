import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts?(x)"],
		environment: "happy-dom"
	}
});
