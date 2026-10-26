/**
 * Index invalide d'un `CREATE INDEX CONCURRENTLY` en échec, sur un vrai
 * Postgres (ADR-029 D18). Schéma jetable `d18_check`, supprimé ensuite.
 *
 * Variable : `SNQL_TEST_PG_URL`.
 */

import { type DDLStatement, lowerDDL, parse, tokenize } from "@sqlnest/snql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Connection } from "../adapter";
import { resolvePostgresConfig } from "../config";
import { EngineExecutionError } from "../errors";
import { runQuery } from "../run";
import { postgresAdapter } from "./adapter";
import { dropFailedIndex } from "./failed-index";

const PG_URL = process.env.SNQL_TEST_PG_URL ?? "";
const NS = "d18_check";

async function admin(text: string): Promise<void> {
	const c = await postgresAdapter.connect(
		resolvePostgresConfig({ url: PG_URL })
	);
	try {
		await c.execute({ engine: "postgres", kind: "sql", text, params: [] });
	} finally {
		await c.close();
	}
}

describe.skipIf(PG_URL === "")(
	"index invalide d'un CONCURRENTLY en échec — Postgres réel (ADR-029 D18)",
	() => {
		let conn: Connection;

		beforeAll(async () => {
			await admin(`DROP SCHEMA IF EXISTS ${NS} CASCADE`);
			await admin(`CREATE SCHEMA ${NS}`);
			conn = await postgresAdapter.connect(
				resolvePostgresConfig({ url: PG_URL, schema: NS })
			);
		}, 20_000);

		afterAll(async () => {
			await conn?.close();
			await admin(`DROP SCHEMA IF EXISTS ${NS} CASCADE`);
		}, 20_000);

		/** Comme le CLI : le schéma introspecté accompagne la requête. */
		const run = async (src: string) =>
			runQuery(conn, src, await conn.introspect());

		/** Index de la table hors clé primaire, lus au catalogue. */
		async function indexes(table: string) {
			const rs = await conn.execute({
				engine: "postgres",
				kind: "sql",
				text: `SELECT i.relname AS name, ix.indisvalid AS valid
					FROM pg_index ix
					JOIN pg_class i ON i.oid = ix.indexrelid
					JOIN pg_class t ON t.oid = ix.indrelid
					JOIN pg_namespace ns ON ns.oid = t.relnamespace
					WHERE ns.nspname = $1 AND t.relname = $2 AND NOT ix.indisprimary
					ORDER BY 1`,
				params: [NS, table]
			});
			return rs.rows;
		}

		it("unique sur des doublons : erreur d'origine, aucun index laissé ; l'essai suivant passe", async () => {
			await run(
				"create table d18_agency { id: int, name: string nullable, primary key (id) }"
			);
			await run(
				'add [{ id: 1, name: "x" }, { id: 2, name: "x" }] into d18_agency'
			);
			const err = await run("add unique index (name) into d18_agency").catch(
				(e: unknown) => e
			);
			expect(err).toBeInstanceOf(EngineExecutionError);
			expect((err as EngineExecutionError).pgError?.code).toBe("23505");
			expect((err as EngineExecutionError).message).not.toContain("non retiré");
			expect(await indexes("d18_agency")).toEqual([]);

			// Sans schéma (appel direct de l'engine) : même nettoyage.
			const bare = await runQuery(
				conn,
				"add unique index (name) into d18_agency"
			).catch((e: unknown) => e);
			expect((bare as EngineExecutionError).pgError?.code).toBe("23505");
			expect(await indexes("d18_agency")).toEqual([]);

			await run('update d18_agency where id = 2 set name = "y"');
			await run("add unique index (name) into d18_agency");
			expect(await indexes("d18_agency")).toEqual([
				{ name: "unique_d18_agency_name", valid: true }
			]);
		}, 30_000);

		it("index invalide resté d'avant : signalé par l'introspection, jamais retiré à la place de l'utilisateur", async () => {
			await run(
				"create table d18_old { id: int, name: string nullable, primary key (id) }"
			);
			await run(
				'add [{ id: 1, name: "x" }, { id: 2, name: "x" }] into d18_old'
			);
			// Laissé par un essai hors SQLNest : l'adapter seul ne nettoie pas.
			await expect(
				conn.execute({
					engine: "postgres",
					kind: "sql",
					text: 'CREATE UNIQUE INDEX CONCURRENTLY "unique_d18_old_name" ON "d18_old" ("name")',
					params: []
				})
			).rejects.toBeInstanceOf(EngineExecutionError);
			expect(await indexes("d18_old")).toEqual([
				{ name: "unique_d18_old_name", valid: false }
			]);

			const before = await conn.introspect();
			expect(
				before.collections.find((c) => c.name === "d18_old")?.indexes
			).toEqual([
				{
					name: "unique_d18_old_name",
					columns: ["name"],
					unique: true,
					valid: false
				}
			]);

			// Nouvel essai avec ou sans schéma : le nom est pris (42P07).
			for (const schema of [before, undefined]) {
				const err = await runQuery(
					conn,
					"add unique index (name) into d18_old",
					schema
				).catch((e: unknown) => e);
				expect((err as EngineExecutionError).pgError?.code).toBe("42P07");
				expect(await indexes("d18_old")).toEqual([
					{ name: "unique_d18_old_name", valid: false }
				]);
			}

			await run("drop index unique_d18_old_name from d18_old");
			expect(await indexes("d18_old")).toEqual([]);
		}, 30_000);

		it("construction d'une autre session en cours : son index, encore invalide, n'est pas retiré", async () => {
			await run(
				"create table d18_busy { id: int, v: int nullable, primary key (id) }"
			);
			await run("add [{ id: 1, v: 1 }, { id: 2, v: 2 }] into d18_busy");
			// Une écriture ouverte retient la construction dans sa 2e phase.
			const writer = new pg.Client({ connectionString: PG_URL });
			await writer.connect();
			try {
				await writer.query("BEGIN");
				await writer.query(`INSERT INTO ${NS}.d18_busy VALUES (3, 3)`);
				const building = run("add index (v) into d18_busy");
				for (let i = 0; i < 100; i++) {
					if ((await indexes("d18_busy")).length > 0) break;
					await new Promise((r) => setTimeout(r, 50));
				}
				expect(await indexes("d18_busy")).toEqual([
					{ name: "idx_d18_busy_v", valid: false }
				]);

				// Le perdant d'une course sur le même nom échoue en 40P01.
				await dropFailedIndex(
					conn,
					lowerDDL(
						parse(tokenize("add index (v) into d18_busy")) as DDLStatement
					),
					undefined,
					new EngineExecutionError("deadlock detected", {
						pgError: { message: "deadlock detected", code: "40P01" }
					})
				);
				expect(await indexes("d18_busy")).toEqual([
					{ name: "idx_d18_busy_v", valid: false }
				]);

				await writer.query("COMMIT");
				await building;
			} finally {
				await writer.end();
			}
			expect(await indexes("d18_busy")).toEqual([
				{ name: "idx_d18_busy_v", valid: true }
			]);

			// Index valide du même nom : intact après l'échec (42P07).
			await expect(run("add index (v) into d18_busy")).rejects.toMatchObject({
				pgError: { code: "42P07" }
			});
			expect(await indexes("d18_busy")).toEqual([
				{ name: "idx_d18_busy_v", valid: true }
			]);
		}, 30_000);
	}
);
