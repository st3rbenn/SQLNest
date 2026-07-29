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
		// Un nom de schéma malformé est rejeté en amont par le querystring Zod
		// (400). Le handler reste une expression simple : ajouter un `reply` 400
		// entrerait en conflit avec le `response.200` typé (SchemaModel).
		async (request) => getSchema(request.query.engine, request.query.schema)
	);
}
