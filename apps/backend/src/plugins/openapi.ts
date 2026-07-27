import { fastifySwagger } from "@fastify/swagger";
import fastifyScalar from "@scalar/fastify-api-reference";
import fp from "fastify-plugin";
import {
	jsonSchemaTransform,
	jsonSchemaTransformObject
} from "fastify-type-provider-zod";
import packageJson from "../../package.json";

export default fp((fastify) => {
	// Disable doc for non-development environments (CI, tests, production)
	if (process.env.NODE_ENV !== "development") {
		return;
	}

	// Generates OpenAPI v3.0.3
	fastify.register(fastifySwagger, {
		openapi: {
			info: {
				title: "SQLNest API",
				version: packageJson.version
			}
		},
		transform: jsonSchemaTransform,
		transformObject: jsonSchemaTransformObject
	});

	// Serve the OpenAPI documentation
	fastify.register(fastifyScalar, {
		routePrefix: "/reference"
	});
});
