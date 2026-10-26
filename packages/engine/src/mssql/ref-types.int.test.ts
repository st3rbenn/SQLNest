/**
 * SQL Server exige le même type des deux côtés d'une FK (type, longueur,
 * échelle, collation) : la colonne de FK prend celui de la colonne
 * référencée, relu au catalogue. Base à soi `e2r_check`, créée puis
 * supprimée ; chaque DDL est aussi confronté au schéma attendu (E/2c).
 *
 * Variable : `SNQL_TEST_MSSQL_URL` (base d'origine, qui sert à créer
 * `e2r_check`).
 */

import {
	applyDdlToSchema,
	compareSchemas,
	type DDLStatement,
	ddlScope,
	lowerDDL,
	parse,
	tokenize
} from "@sqlnest/snql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Connection } from "../adapter";
import { runQuery } from "../run";
import { mssqlAdapter } from "./adapter";
import { resolveMssqlConfig } from "./config";

const ADMIN_URL = process.env.SNQL_TEST_MSSQL_URL ?? "";
const DATABASE = "e2r_check";
const DROP_DATABASE = `IF DB_ID(N'${DATABASE}') IS NOT NULL BEGIN ALTER DATABASE ${DATABASE} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DATABASE}; END`;

async function onAdmin(text: string): Promise<void> {
	const conn = await mssqlAdapter.connect(
		resolveMssqlConfig({ url: ADMIN_URL })
	);
	try {
		await conn.execute({
			engine: "mssql",
			kind: "sql",
			text,
			params: [],
			paramSpans: []
		});
	} finally {
		await conn.close();
	}
}

describe.skipIf(ADMIN_URL === "")(
	"mssql — type des colonnes de FK (intégration)",
	() => {
		let conn: Connection;

		beforeAll(async () => {
			await onAdmin(DROP_DATABASE);
			await onAdmin(`CREATE DATABASE ${DATABASE}`);
			const url = new URL(ADMIN_URL);
			url.pathname = `/${DATABASE}`;
			conn = await mssqlAdapter.connect(
				resolveMssqlConfig({ url: url.toString() })
			);
		}, 60_000);

		afterAll(async () => {
			await conn?.close();
			await onAdmin(DROP_DATABASE);
		}, 60_000);

		/** T-SQL brut (tables d'une base existante, contraintes posées à la main). */
		const sql = (text: string, params: readonly unknown[] = []) =>
			conn.execute({
				engine: "mssql",
				kind: "sql",
				text,
				params: [...params],
				paramSpans: []
			});

		/**
		 * SNQL avec le schéma introspecté, comme la console. Un DDL réussi est
		 * confronté au schéma attendu : aucun écart.
		 */
		async function run(src: string) {
			const before = await conn.introspect();
			const statement = parse(tokenize(src));
			const result = await runQuery(conn, src, before);
			if (statement.operation === "ddl") {
				const plan = lowerDDL(statement as DDLStatement, before);
				expect(
					compareSchemas(
						applyDdlToSchema(before, plan),
						await conn.introspect(),
						ddlScope(plan, before)
					)
				).toEqual([]);
			}
			return result;
		}

		/** Ce que SQL Server compare entre les deux colonnes d'une FK. */
		async function nativeType(table: string, column: string) {
			const rs = await sql(
				"SELECT TYPE_NAME(c.system_type_id) AS type, c.max_length AS bytes, c.precision AS precision, c.scale AS scale, c.collation_name AS collation FROM sys.columns c WHERE c.object_id = OBJECT_ID(@p1) AND c.name = @p2",
				[table, column]
			);
			return rs.rows[0];
		}

		/** FK, approuvées (`WITH CHECK`) et actives. */
		async function trustedRefs(table: string): Promise<string[]> {
			const rs = await sql(
				"SELECT name FROM sys.foreign_keys WHERE parent_object_id = OBJECT_ID(@p1) AND is_disabled = 0 AND is_not_trusted = 0",
				[table]
			);
			return rs.rows.map((r) => String(r.name)).sort();
		}

		it("le cas du 2026-10-26 : FK vers un texte unique, vers la table créée, add column … ref", async () => {
			await run(
				"create table p { id: int, code: string unique, primary key (id) }"
			);
			await run(
				"create table c { id: int, b: string nullable ref p.code, primary key (id) }"
			);
			const key = await nativeType("p", "code");
			expect(key).toMatchObject({ type: "nvarchar", bytes: 900 });
			expect(await nativeType("c", "b")).toEqual(key);

			await run('add { id: 1, code: "a" } into p');
			await run('add { id: 1, b: "a" } into c');
			await run("add { id: 2 } into c");
			await expect(run('add { id: 3, b: "ghost" } into c')).rejects.toThrow(
				/FOREIGN KEY/
			);

			// Défaut sur une colonne nullable : les lignes existantes le reçoivent.
			await run('add column b2 string nullable default "a" ref p.code into c');
			expect(await nativeType("c", "b2")).toEqual(key);
			const rows = await run("find c pick id, b2 sort id");
			expect(rows.rows).toEqual([
				{ id: 1, b2: "a" },
				{ id: 2, b2: "a" }
			]);

			await run(
				"create table cat { code: string, parent: string nullable ref self.code, primary key (code) }"
			);
			expect(await nativeType("cat", "parent")).toEqual(
				await nativeType("cat", "code")
			);
			expect(await trustedRefs("c")).toEqual(["fk_c_b2_p", "fk_c_b_p"]);
		}, 60_000);

		it("clés d'une base existante : varchar, nvarchar(255) d'une autre collation, bigint, decimal(10, 2)", async () => {
			await sql(
				"CREATE TABLE legacy (id bigint NOT NULL PRIMARY KEY, code varchar(50) NOT NULL UNIQUE, label nvarchar(255) COLLATE Latin1_General_CS_AS NOT NULL UNIQUE, amount decimal(10, 2) NOT NULL UNIQUE)"
			);
			await run(
				"create table k { id: int, legacy_id: int ref legacy.id, legacy_code: string nullable ref legacy.code, legacy_label: string nullable ref legacy.label, legacy_amount: decimal nullable ref legacy.amount, primary key (id) }"
			);
			for (const [fk, key] of [
				["legacy_id", "id"],
				["legacy_code", "code"],
				["legacy_label", "label"],
				["legacy_amount", "amount"]
			] as const) {
				expect(await nativeType("k", fk)).toEqual(
					await nativeType("legacy", key)
				);
			}
			await run(
				"add column legacy_code2 string nullable ref legacy.code into k"
			);
			expect(await nativeType("k", "legacy_code2")).toEqual(
				await nativeType("legacy", "code")
			);

			// La collation sensible à la casse suit : 'A' ne référence pas 'a'.
			await sql("INSERT INTO legacy VALUES (1, 'a', N'a', 1.5)");
			await run(
				'add { id: 1, legacy_id: 1, legacy_label: "a", legacy_amount: 1.5 } into k'
			);
			await expect(
				run('add { id: 2, legacy_id: 1, legacy_label: "A" } into k')
			).rejects.toThrow(/FOREIGN KEY/);
		}, 60_000);

		it("add ref sur une colonne existante : valeurs trop longues refusées, puis colonne convertie avec ses dépendants et la colonne qui la référence", async () => {
			await sql("CREATE TABLE ref20 (code nvarchar(20) NOT NULL PRIMARY KEY)");
			await sql("INSERT INTO ref20 VALUES (N'a'), (N'b')");
			await run(
				'create table src { id: int, code: string unique nullable default "a", primary key (id) }'
			);
			await run(
				"create table kid { id: int, src_code: string nullable ref src.code, primary key (id) }"
			);
			await sql(
				"ALTER TABLE src ADD CONSTRAINT ck_src_code CHECK (code <> N'zz')"
			);
			await sql("CREATE STATISTICS st_src_code ON src (code) WITH NORECOMPUTE");
			await run('add { id: 1, code: "a" } into src');
			await run(`add { id: 2, code: "${"x".repeat(25)}" } into src`);
			await run('add { id: 1, src_code: "a" } into kid');
			const before = await nativeType("src", "code");
			expect(before).toMatchObject({ type: "nvarchar", bytes: 900 });

			const add = "add ref (code) references ref20.code into src";
			await expect(run(add)).rejects.toThrow(
				"'code' dépasse 20 caractères sur 1 ligne de 'src', la longueur de ref20.code — à raccourcir avant la foreign key : find src where length(code) > 20"
			);
			expect(await nativeType("src", "code")).toEqual(before);
			expect(
				(await run("find src where length(code) > 20 pick id")).rows
			).toEqual([{ id: 2 }]);

			// La colonne qui la référence est convertie aussi : ses espaces finaux
			// (égaux pour la FK) seraient rognés sans erreur.
			await run('update src where id = 2 set code = "b"');
			await sql(`UPDATE kid SET src_code = N'a${" ".repeat(30)}' WHERE id = 1`);
			await expect(run(add)).rejects.toThrow(
				"'src_code' dépasse 20 caractères sur 1 ligne de 'kid', la longueur de ref20.code"
			);
			await sql("UPDATE kid SET src_code = N'a' WHERE id = 1");

			// Orphelin : la FK est refusée, la conversion annulée avec elle.
			await run('add { id: 3, code: "ghost" } into src');
			await expect(run(add)).rejects.toThrow(/FOREIGN KEY/);
			expect(await nativeType("src", "code")).toEqual(before);
			await run("remove from src where id = 3");

			await run(add);
			const key = await nativeType("ref20", "code");
			expect(await nativeType("src", "code")).toEqual(key);
			expect(await nativeType("kid", "src_code")).toEqual(key);
			expect(await trustedRefs("src")).toEqual(["fk_src_code_ref20"]);
			expect(await trustedRefs("kid")).toEqual(["fk_kid_src_code_src"]);
			const dependents = await sql(
				"SELECT (SELECT COUNT(*) FROM sys.default_constraints WHERE parent_object_id = OBJECT_ID('src')) AS defaults, (SELECT COUNT(*) FROM sys.check_constraints WHERE name = 'ck_src_code') AS checks, (SELECT COUNT(*) FROM sys.key_constraints WHERE parent_object_id = OBJECT_ID('src') AND type = 'UQ') AS uniques, (SELECT COUNT(*) FROM sys.stats WHERE name = 'st_src_code' AND no_recompute = 1) AS stats"
			);
			expect(dependents.rows[0]).toEqual({
				defaults: 1,
				checks: 1,
				uniques: 1,
				stats: 1
			});
			await expect(run(`add { id: 4, code: "c" } into src`)).rejects.toThrow(
				/FOREIGN KEY/
			);

			// Même type : rien n'est converti. int → bigint : élargi.
			await sql("CREATE TABLE big (id bigint NOT NULL PRIMARY KEY)");
			await sql("INSERT INTO big VALUES (1)");
			await run("add column big_id int nullable into src");
			await run("update src where id = 1 set big_id = 1");
			await run("add ref (big_id) references big.id into src");
			expect(await nativeType("src", "big_id")).toEqual(
				await nativeType("big", "id")
			);
			await run(
				"add ref (code) references ref20.code as fk_src_code_again into src"
			);
			expect(await nativeType("src", "code")).toEqual(key);
		}, 120_000);

		it("set type : texte indexé d'un seul côté, FK sœurs — la chaîne entière prend le même type", async () => {
			await run(
				"create table p3 { id: int, code: string unique, primary key (id) }"
			);
			await run(
				"create table c3 { id: int, b: string nullable ref p3.code, pid: int nullable ref p3.id, primary key (id) }"
			);
			await run(
				"create table s3 { id: int, pid: int nullable ref p3.id, primary key (id) }"
			);
			await run('add { id: 1, code: "a" } into p3');
			await run('add { id: 1, b: "a", pid: 1 } into c3');
			await run("add { id: 1, pid: 1 } into s3");

			// c3.b n'est pas indexée, p3.code l'est : nvarchar(450) des deux côtés.
			await run("alter column c3.b set type string");
			expect(await nativeType("c3", "b")).toEqual(
				await nativeType("p3", "code")
			);

			// c3.pid → p3.id ← s3.pid : la sœur suit.
			await run("alter column c3.pid set type bigint");
			for (const [table, column] of [
				["c3", "pid"],
				["p3", "id"],
				["s3", "pid"]
			] as const) {
				expect(await nativeType(table, column)).toMatchObject({
					type: "bigint"
				});
			}
			expect(await trustedRefs("c3")).toEqual(["fk_c3_b_p3", "fk_c3_pid_p3"]);
			expect(await trustedRefs("s3")).toEqual(["fk_s3_pid_p3"]);
		}, 60_000);

		it("add ref compensée par triggers (2ᵉ chemin de cascade) sur une colonne à convertir", async () => {
			await run(
				"create table pe { id: int, code: string unique, primary key (id) }"
			);
			await run(
				"create table ce { id: int, a: int nullable ref pe.id on delete cascade, b: string nullable, primary key (id) }"
			);
			await run('add [{ id: 1, code: "x" }, { id: 2, code: "y" }] into pe');
			await run('add { id: 10, a: 1, b: "y" } into ce');

			await run("add ref (b) references pe.code on delete set null into ce");
			expect(await nativeType("ce", "b")).toEqual(
				await nativeType("pe", "code")
			);
			expect(
				(await conn.introspect()).refs?.find((r) => r.name === "fk_ce_b_pe")
			).toMatchObject({ onDelete: "set-null", emulated: true });
			await expect(run('add { id: 11, b: "ghost" } into ce')).rejects.toThrow(
				"insert dans 'ce' viole la foreign key 'fk_ce_b_pe'"
			);
			await run("remove from pe where id = 2");
			expect((await run("find ce")).rows).toEqual([{ id: 10, a: 1, b: null }]);
		}, 60_000);
	}
);
