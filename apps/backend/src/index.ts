import cors from "@fastify/cors";
import Fastify from "fastify";
import { app } from "./app";
import {
	serializerCompiler,
	validatorCompiler,
} from "fastify-type-provider-zod";
import defaultRequestContext from "@fastify/request-context";

const fastify = Fastify({
	logger: {
		transport: {
			target: "pino-pretty",
			options: {
				colorize: true,
			},
		},
	},
});

// register plugins
fastify.register(cors, {
	origin: [process.env.FRONTEND_URL as string],
	methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
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
