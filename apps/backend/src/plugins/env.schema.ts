import env from "@fastify/env";
import fp from "fastify-plugin";

const schema = {
	type: "object",
	properties: {
		NODE_ENV: { type: "string", enum: ["development", "production"], default: "development" },
		FRONTEND_URL: { type: "string", default: "http://localhost:3000" },
		BASE_URL: { type: "string", default: "http://localhost:4000" }
	},
	required: ["NODE_ENV", "FRONTEND_URL", "BASE_URL"]
};

const options = {
	schema,
	dotenv: true,
	data: process.env
};

export default fp((fastify) => {
	fastify.register(env, options);
});
