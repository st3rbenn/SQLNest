import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getSchema } from "../../domains/schema/get";
import {
	GetSchemaQuerySchema,
	GetSchemaResponseSchema
} from "../../domains/schema/get.schema";

export default function schemaRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	instance.get(
		"",
		{
			schema: {
				querystring: GetSchemaQuerySchema,
				response: {
					200: GetSchemaResponseSchema
				}
			}
		},
		async (request) => getSchema(request.query.engine)
	);
}
