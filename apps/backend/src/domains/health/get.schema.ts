import z from "zod/v4";

export const SERVER_STATUS = z.enum(["OK", "PENDING", "ERROR"]);

export const GetHealthResponseSchema = z.object({
	status: SERVER_STATUS,
	service: z.string(),
	timestamp: z.date(),
});

export type GetHealthQuery = z.infer<typeof GetHealthResponseSchema>;

z.globalRegistry.add(GetHealthResponseSchema, {
	id: "HealthResponse",
});
