import { schema as dbSchema } from "@sqlnest/db";
import { count, eq } from "drizzle-orm";
import type { DbOrTx } from "./db";

export async function countCanvasStates(
	db: DbOrTx,
	userId: string
): Promise<number> {
	const rows = await db
		.select({ total: count() })
		.from(dbSchema.canvasState)
		.where(eq(dbSchema.canvasState.userId, userId));

	return rows[0]?.total ?? 0;
}
