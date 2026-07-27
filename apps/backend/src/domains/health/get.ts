import type { GetHealthQuery } from "./get.schema";

export async function getHealth(): Promise<GetHealthQuery> {
	return {
		status: "OK",
		service: "sqlnest-backend",
		timestamp: new Date()
	};
}
