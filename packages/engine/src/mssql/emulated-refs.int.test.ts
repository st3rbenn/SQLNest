/**
 * FK compensées sous SQL Server (ADR-031 D9) : une action qui fermerait un
 * cycle ou ouvrirait un 2ᵉ chemin de cascade (1785) passe par des triggers ;
 * la FK reste NO ACTION et désactivée. Base `e2x_refs`, créée puis supprimée.
 *
 * Variable : `SNQL_TEST_MSSQL_URL`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Connection } from "../adapter";
import { connect, resolveMssqlConfig } from "../index";
import { runQuery } from "../run";

const ADMIN = process.env.SNQL_TEST_MSSQL_URL ?? "";
const DATABASE = "e2x_refs";

function isolated(url: string): string {
	const u = new URL(url);
	u.pathname = `/${DATABASE}`;
	return u.toString();
}

async function raw(url: string, text: string): Promise<void> {
	const c = await connect(resolveMssqlConfig({ url }));
	try {
		await c.execute({ engine: "mssql", kind: "sql", text, params: [] });
	} finally {
		await c.close();
	}
}

const DROP = `IF DB_ID(N'${DATABASE}') IS NOT NULL BEGIN ALTER DATABASE ${DATABASE} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DATABASE}; END`;

describe.skipIf(ADMIN === "")(
	"FK compensées sous SQL Server (ADR-031 D9)",
	() => {
		let conn: Connection;
		const run = async (src: string) =>
			runQuery(conn, src, await conn.introspect());

		beforeAll(async () => {
			await raw(ADMIN, `${DROP}; CREATE DATABASE ${DATABASE};`);
			conn = await connect(resolveMssqlConfig({ url: isolated(ADMIN) }));
		});

		afterAll(async () => {
			await conn?.close();
			if (ADMIN !== "") await raw(ADMIN, DROP);
		});

		it("2ᵉ chemin de cascade : cascade native et set null par trigger ; orpheline refusée ; lignes écrites renvoyées", async () => {
			await run(
				"create table p { id: int, code: int unique, primary key (id) }"
			);
			await run(
				"create table c { id: int, a: int nullable ref p.id on delete cascade, b: int nullable ref p.code on delete set null on update cascade, primary key (id) }"
			);
			const schema = await conn.introspect();
			expect(
				schema.refs?.map((r) => [
					r.name,
					r.onDelete,
					r.onUpdate,
					r.emulated ?? false
				])
			).toEqual([
				["fk_c_a_p", "cascade", "restrict", false],
				["fk_c_b_p", "set-null", "cascade", true]
			]);
			expect(schema.collections.map((t) => [t.name, t.triggers])).toEqual([
				["c", ["insert", "update"]],
				["p", ["update", "delete"]]
			]);
			expect(
				(
					await run(
						"add [{ id: 1, code: 100 }, { id: 2, code: 200 }, { id: 3, code: 300 }] into p"
					)
				).rows
			).toHaveLength(3);
			expect(
				(
					await run(
						"add [{ id: 10, a: 1, b: 200 }, { id: 11, a: 2, b: 100 }] into c"
					)
				).rows
			).toEqual([
				{ id: 10, a: 1, b: 200 },
				{ id: 11, a: 2, b: 100 }
			]);
			await expect(run("add { id: 12, a: 1, b: 999 } into c")).rejects.toThrow(
				"insert dans 'c' viole la foreign key 'fk_c_b_p' : 'b' = 999 ne référence aucune ligne de p.code"
			);
			expect((await run("update c where id = 10 set b = 300")).rows).toEqual([
				{ id: 10, a: 1, b: 300 }
			]);
			expect((await run("remove from p where id = 3")).rows).toEqual([
				{ id: 3, code: 300 }
			]);
			expect((await run("find c sort id")).rows).toEqual([
				{ id: 10, a: 1, b: null },
				{ id: 11, a: 2, b: 100 }
			]);
			expect((await run("remove from p where id = 2")).rows).toHaveLength(1);
			expect((await run("find c")).rows).toEqual([{ id: 10, a: 1, b: null }]);
		});

		it("on update cascade par trigger : une ligne, plusieurs reliées par une clé inchangée ; sans elle, l'instruction est annulée", async () => {
			await run("update c where id = 10 set b = 100");
			await run("update p where id = 1 set code = 111");
			expect((await run("find c")).rows).toEqual([{ id: 10, a: 1, b: 111 }]);
			await run("add { id: 4, code: 400 } into p");
			await run("add { id: 13, a: 4, b: 400 } into c");
			await run("update p set code = code + 1000");
			expect((await run("find c sort id")).rows).toEqual([
				{ id: 10, a: 1, b: 1111 },
				{ id: 13, a: 4, b: 1400 }
			]);
			await expect(
				run("update p set code = code + 1, id = id + 0")
			).rejects.toThrow(
				"plusieurs lignes changent 'code' sans autre clé inchangée"
			);
			expect((await run("find p sort id")).rows).toEqual([
				{ id: 1, code: 1111 },
				{ id: 4, code: 1400 }
			]);
		});

		it("rename column, changement de type (dépendants recréés), drop ref et add ref : la compensation suit", async () => {
			await run("rename column c.b to backup_code");
			await expect(
				run("add { id: 14, a: 1, backup_code: 5 } into c")
			).rejects.toThrow(
				"'backup_code' = 5 ne référence aucune ligne de p.code"
			);
			await run("alter column c.backup_code set type bigint");
			const altered = await conn.introspect();
			expect(altered.refs?.find((r) => r.name === "fk_c_b_p")).toMatchObject({
				onDelete: "set-null",
				onUpdate: "cascade",
				emulated: true
			});
			await run("remove from p where id = 4");
			expect((await run("find c sort id")).rows).toEqual([
				{ id: 10, a: 1, backup_code: "1111" }
			]);
			await run("drop ref fk_c_b_p from c");
			expect(
				(await conn.introspect()).collections.every(
					(t) => t.triggers === undefined
				)
			).toBe(true);
			await run("add { id: 15, a: 1, backup_code: 777 } into c");
			await expect(
				run("add ref (backup_code) references p.code on delete set null into c")
			).rejects.toThrow();
			await run("remove from c where id = 15");
			await run(
				"add ref (backup_code) references p.code on delete set null into c"
			);
			expect(
				(await conn.introspect()).refs?.find(
					(r) => r.name === "fk_c_backup_code_p"
				)
			).toMatchObject({ onDelete: "set-null", emulated: true });
			await run("drop column backup_code from c");
			expect(
				(await conn.introspect()).collections.every(
					(t) => t.triggers === undefined
				)
			).toBe(true);
		});

		it("auto-référence en cascade : un arbre profond supprimé depuis sa racine ; upsert renvoyé", async () => {
			await run(
				"create table node { id: int, parent_id: int nullable ref self.id on delete cascade, label: string, primary key (id) }"
			);
			await run('add { id: 1, label: "racine" } into node');
			for (let id = 2; id <= 40; id += 1) {
				await run(
					`add { id: ${id}, parent_id: ${id - 1}, label: "n" } into node`
				);
			}
			expect(
				(
					await run(
						'add { id: 40, parent_id: 39, label: "feuille" } into node on conflict (id) edit set label = "feuille"'
					)
				).rows
			).toEqual([{ id: 40, parent_id: 39, label: "feuille" }]);
			await run("remove from node where id = 1");
			expect(
				Number((await run("find node pick count(*) as n")).rows[0]?.n)
			).toBe(0);
			await run("drop table node");
			await run("drop table c");
			expect(
				(await conn.introspect()).collections.every(
					(t) => t.triggers === undefined
				)
			).toBe(true);
		});
	}
);
