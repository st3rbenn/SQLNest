import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AutoLoad from "@fastify/autoload";
import type { FastifyPluginCallback } from "fastify";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");

const ROUTE_IGNORE_PATTERN = /__mocks__|\.test\./;

export const app: FastifyPluginCallback = (fastify) => {
	void fastify.register(AutoLoad, {
		dir: join(__dirname, "plugins")
	});

	void fastify.register(AutoLoad, {
		dir: join(__dirname, "routes"),
		ignorePattern: ROUTE_IGNORE_PATTERN,
		routeParams: true
	});
};
