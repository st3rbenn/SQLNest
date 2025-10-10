import { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { GetHealthQuery } from "../../domains/health/get.schema";
import { createTestApp } from "../../utils/testapp";
import healthRoute from "./root";

describe("GET /health", () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		app = createTestApp();
		await app.register(healthRoute, { prefix: "/health" });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
		vi.clearAllMocks();
	});

	test("should return positive response if API is usable", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/health",
		});

		const data = (await response.json()) as GetHealthQuery;

		expect(response.statusCode).toBe(200);
		expect(data.status).toBe("OK");
		expect(data.service).toBe("sqlnest-backend");
		expect(typeof data.timestamp).toBe("string");
	});

	test("should return 404 for unknown route", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/unknown-route",
		});

		expect(response.statusCode).toBe(404);
	});
});
