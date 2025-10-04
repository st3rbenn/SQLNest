import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { getHealth } from "../../domains/health/get";
import { GetHealthResponseSchema } from "../../domains/health/get.schema";

export default function healthRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	instance.get(
		"",
		{
			schema: {
				response: {
					200: GetHealthResponseSchema,
					503: {
						...GetHealthResponseSchema,
						status: { const: "ERROR" },
					},
				},
			},
		},
		async (request, reply) => getHealth(),
	);
}
