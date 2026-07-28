import z from "zod/v4";

export const RunQueryBodySchema = z.object({
	engine: z.enum(["postgres", "mongodb"]).default("postgres"),
	source: z.string().min(1)
});

export type RunQueryBody = z.infer<typeof RunQueryBodySchema>;
