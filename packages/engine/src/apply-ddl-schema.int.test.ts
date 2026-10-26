/**
 * Contrôle de structure sur les vraies bases (ADR-037 D5, E/2c) : à chaque
 * DDL, le schéma attendu (`applyDdlToSchema` sur l'introspection d'avant) est
 * comparé à l'introspection d'après, sur ce que le DDL touche. Tables et enum
 * temporaires `e2c_*`.
 *
 * Variables : `SNQL_TEST_PG_URL`, `SNQL_TEST_MSSQL_URL`, `SNQL_TEST_MONGO_URL`.
 */

import {
	applyDdlToSchema,
	compareSchemas,
	type DDLStatement,
	ddlScope,
	lowerDDL,
	parse,
	type SchemaDiff,
	tokenize
} from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import type { Connection } from "./adapter";
import {
	connect,
	resolveMongoConfig,
	resolveMssqlConfig,
	resolvePostgresConfig
} from "./index";
import { runQuery } from "./run";

/** Isolés des autres essais, qui tournent en parallèle sur les mêmes bases. */
const NAMESPACE = "e2c_check";

/**
 * URL dans un espace à soi : schéma PG, base Mongo ou SQL Server (dont le DML
 * ne suit pas encore `?schema=`).
 */
function isolated(url: string, engine: string): string {
	if (url === "") return url;
	const u = new URL(url);
	if (engine === "postgres") u.searchParams.set("schema", NAMESPACE);
	else u.pathname = `/${NAMESPACE}`;
	return u.toString();
}

const ENGINES = [
	{
		engine: "postgres",
		url: isolated(process.env.SNQL_TEST_PG_URL ?? "", "postgres"),
		config: (url: string) => resolvePostgresConfig({ url }),
		setup: `CREATE SCHEMA IF NOT EXISTS ${NAMESPACE}`,
		teardown: `DROP SCHEMA IF EXISTS ${NAMESPACE} CASCADE`
	},
	{
		engine: "mssql",
		url: isolated(process.env.SNQL_TEST_MSSQL_URL ?? "", "mssql"),
		config: (url: string) => resolveMssqlConfig({ url }),
		// Base créée et supprimée depuis la base d'origine.
		admin: process.env.SNQL_TEST_MSSQL_URL ?? "",
		setup: `IF DB_ID(N'${NAMESPACE}') IS NULL CREATE DATABASE ${NAMESPACE}`,
		teardown: `IF DB_ID(N'${NAMESPACE}') IS NOT NULL BEGIN ALTER DATABASE ${NAMESPACE} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${NAMESPACE}; END`
	},
	{
		engine: "mongodb",
		url: isolated(process.env.SNQL_TEST_MONGO_URL ?? "", "mongodb"),
		config: (url: string) => resolveMongoConfig({ url }),
		setup: undefined,
		teardown: undefined
	}
] as const;

/** DDL contrôlés ; les écritures (`add`, `update`) préparent des données et prouvent les CHECK et validateurs. */
const SCENARIO = [
	'create enum e2c_status { "draft", "live" }',
	'create table e2c_parent { id: int, code: string, label: string nullable default "n/a", primary key (id) }',
	"add unique index (code) into e2c_parent",
	"create table e2c_child { id: int, parent_id: int nullable ref e2c_parent.id on delete cascade, qty: int default 1, tag: string unique, status: e2c_status nullable, primary key (id) }",
	'add { id: 1, code: "a" } into e2c_parent',
	'add { id: 1, parent_id: 1, qty: 2, tag: "t1", status: "live" } into e2c_child',
	"add column note string nullable into e2c_child",
	"add index (qty) into e2c_child",
	"alter column e2c_child.qty drop default",
	"alter column e2c_child.qty set default 5",
	'update e2c_child where id = 1 set note = "n"',
	"alter column e2c_child.note set not null",
	"alter column e2c_child.note set nullable",
	"rename column e2c_child.note to remark",
	'add enum member e2c_status "archived"',
	'add { id: 2, parent_id: 1, qty: 1, tag: "t2", status: "archived" } into e2c_child',
	"rename column e2c_child.status to state",
	'add enum member e2c_status "deleted"',
	'add { id: 3, qty: 1, tag: "t3", state: "deleted" } into e2c_child',
	// Après les écritures : Mongo n'y convertit pas encore un entier en long.
	"alter column e2c_child.qty set type bigint",
	"drop index idx_e2c_child_qty from e2c_child",
	"drop ref fk_e2c_child_parent_id_e2c_parent from e2c_child",
	"add ref (parent_id) references e2c_parent.id on delete set null into e2c_child",
	// 2ᵉ chemin de cascade vers e2c_child : compensé par triggers sous SQL Server (ADR-031 D9).
	"add column alt_parent_id int nullable ref e2c_parent.id on delete cascade into e2c_child",
	"add index (qty, tag) into e2c_child",
	"drop column remark from e2c_child",
	"drop column state from e2c_child",
	"drop column tag from e2c_child",
	"drop column qty from e2c_child",
	"drop column parent_id from e2c_child",
	"drop table e2c_child",
	"drop table e2c_parent",
	"drop enum e2c_status",
	"create table e2c_types { id: int, s: string nullable, i: int nullable, big: bigint nullable, f: float nullable, n: decimal nullable, b: bool nullable, d: date nullable, j: json nullable, a: array nullable, u: uuid nullable, primary key (id) }",
	"drop table e2c_types"
];

const CLEANUP = [
	"drop table e2c_types if exists",
	"drop table e2c_child if exists",
	"drop table e2c_parent if exists",
	"drop enum e2c_status if exists cascade"
];

async function cleanup(conn: Connection): Promise<void> {
	for (const src of CLEANUP) {
		try {
			await runQuery(conn, src, await conn.introspect());
		} catch {
			// Déjà absent.
		}
	}
}

/** Connexion dans l'espace isolé, créé au besoin ; `close` le supprime. */
async function open(
	engine: (typeof ENGINES)[number]
): Promise<{ readonly conn: Connection; readonly close: () => Promise<void> }> {
	const admin = "admin" in engine ? engine.admin : undefined;
	const raw = async (url: string, text: string): Promise<void> => {
		const c = await connect(engine.config(url));
		try {
			await c.execute({ engine: engine.engine, kind: "sql", text, params: [] });
		} finally {
			await c.close();
		}
	};
	if (engine.setup !== undefined) await raw(admin ?? engine.url, engine.setup);
	const conn = await connect(engine.config(engine.url));
	await cleanup(conn);
	return {
		conn,
		close: async () => {
			try {
				await cleanup(conn);
				if (engine.engine === "mongodb") {
					await conn.execute({
						engine: "mongodb",
						kind: "mongo-raw",
						command: { dropDatabase: 1 }
					});
				}
			} finally {
				await conn.close();
			}
			if (engine.teardown !== undefined) {
				await raw(admin ?? engine.url, engine.teardown);
			}
		}
	};
}

for (const engine of ENGINES) {
	describe.skipIf(engine.url === "")(
		`contrôle de structure — ${engine.engine}`,
		() => {
			it("chaque DDL du scénario : schéma attendu = introspection d'après", async () => {
				const { conn, close } = await open(engine);
				const results: {
					readonly src: string;
					readonly diffs: SchemaDiff[];
				}[] = [];
				try {
					for (const src of SCENARIO) {
						const before = await conn.introspect();
						const statement = parse(tokenize(src));
						if (statement.operation !== "ddl") {
							await runQuery(conn, src, before);
							continue;
						}
						const plan = lowerDDL(statement as DDLStatement, before);
						await runQuery(conn, src, before);
						const after = await conn.introspect();
						results.push({
							src,
							diffs: compareSchemas(
								applyDdlToSchema(before, plan),
								after,
								ddlScope(plan, before)
							)
						});
					}
				} finally {
					await close();
				}
				expect(results.filter((r) => r.diffs.length > 0)).toEqual([]);
			}, 180_000);

			it("drop enum encore utilisé : refusé, l'enum reste", async () => {
				const { conn, close } = await open(engine);
				try {
					await runQuery(
						conn,
						'create enum e2c_status { "draft" }',
						await conn.introspect()
					);
					await runQuery(
						conn,
						"create table e2c_child { id: int, status: e2c_status nullable, primary key (id) }",
						await conn.introspect()
					);
					await expect(
						runQuery(conn, "drop enum e2c_status", await conn.introspect())
					).rejects.toThrow("Enum 'e2c_status' utilisé par e2c_child.status");
					expect(
						(await conn.introspect()).enums?.some(
							(e) => e.name === "e2c_status"
						)
					).toBe(true);
				} finally {
					await close();
				}
			}, 60_000);
		}
	);
}
