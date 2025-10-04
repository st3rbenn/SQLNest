import Fastify, { type FastifyInstance } from "fastify";
import {
	serializerCompiler,
	validatorCompiler,
} from "fastify-type-provider-zod";

export function createTestApp(): FastifyInstance {
	const server = Fastify({
		logger: true,
	});
	void server.setValidatorCompiler(validatorCompiler);
	void server.setSerializerCompiler(serializerCompiler);

	return server;
}
