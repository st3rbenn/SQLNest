import { defineOp } from "./op";

export const pingOp = defineOp({
	name: "ping",
	async run(_req, ctx) {
		return (await ctx.connection()).ping();
	}
});
