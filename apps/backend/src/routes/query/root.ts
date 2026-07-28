import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { runUserQuery } from "../../domains/query/run";
import { RunQueryBodySchema } from "../../domains/query/run.schema";

export default function queryRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	instance.post(
		"",
		{
			schema: {
				body: RunQueryBodySchema
			}
		},
		async (request, reply) => {
			try {
				return await runUserQuery(
					request.body.engine,
					request.body.source,
					request.body.schema
				);
			} catch (err) {
				// Erreur de requête (SNQL invalide) ou de base : message sûr (les
				// erreurs typées du cœur/engine masquent déjà les secrets).
				request.log.warn({ err }, "query failed");
				const message = err instanceof Error ? err.message : "Erreur inconnue";
				return reply.code(400).send({ message });
			}
		}
	);
}
