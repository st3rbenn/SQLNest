import cors from "@fastify/cors";
import defaultRequestContext from "@fastify/request-context";
import Fastify from "fastify";
import {
	serializerCompiler,
	validatorCompiler
} from "fastify-type-provider-zod";
import { app } from "./app";

const fastify = Fastify({
	logger: {
		transport: {
			target: "pino-pretty",
			options: {
				colorize: true
			}
		}
	}
});

// register plugins
fastify.register(cors, {
	origin: ["http://localhost:3000"],
	methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
});

fastify.register(defaultRequestContext);

// Zod schemas conversion
fastify.setValidatorCompiler(validatorCompiler);
fastify.setSerializerCompiler(serializerCompiler);

fastify.register(app);

const start = async () => {
	try {
		await fastify.listen({ host: "0.0.0.0", port: 4000 });
	} catch (err: unknown) {
		fastify.log.error(err);
		process.exit(1);
	}
};
start();
