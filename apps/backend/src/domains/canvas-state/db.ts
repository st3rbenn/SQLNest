import type { FastifyInstance } from "fastify";

type Db = FastifyInstance["db"];

/** Union `db | tx` — les domain functions acceptent l'un ou l'autre pour
 * fonctionner à la fois hors et à l'intérieur d'une transaction Drizzle. */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
