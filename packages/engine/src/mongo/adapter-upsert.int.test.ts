import { describe, expect, it } from "vitest";
import { runQuery } from "../run";
import { mongoAdapter } from "./adapter";
import { resolveMongoConfig } from "./config";

/**
 * Upsert `add … on conflict` sur un vrai MongoDB (ADR-029 D16) :
 * `SNQL_TEST_MONGO_URL=mongodb://localhost:27017/sqlnest_demo?directConnection=true`.
 * Sans cette variable, tout le bloc est sauté. Tables `e2u_*`, supprimées ensuite.
 */
const MONGO_URL = process.env.SNQL_TEST_MONGO_URL ?? "";
const hasMongo = MONGO_URL !== "";
const loadConfig = () => resolveMongoConfig({ url: MONGO_URL });
const U1 = "6f1c2b9e-1b2a-4c3d-8e9f-0a1b2c3d4e5f";

describe.skipIf(!hasMongo)("mongodb adapter — upsert (ADR-029 D16)", () => {
	it("insertion : la ligne proposée ; conflit : l'edit set ; ignore ne compte que les insertions", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		const rows = async () =>
			(await runQuery(conn, "find e2u_t pick code, f, n, tag sort code")).rows;
		try {
			await runQuery(conn, "drop table e2u_t if exists");
			await runQuery(
				conn,
				'create table e2u_t { code: text, f: int nullable, n: int nullable, tag: text default "neuf" }'
			);

			const inserted = await runQuery(
				conn,
				'add {code: "c", f: 1} into e2u_t on conflict (code) edit set f = 2'
			);
			expect(inserted.rowCount).toBe(1);
			expect(await rows()).toEqual([{ code: "c", f: 1, tag: "neuf" }]);

			const edited = await runQuery(
				conn,
				'add {code: "c", f: 5, n: 9} into e2u_t on conflict (code) edit set f = new.f'
			);
			expect(edited.rowCount).toBe(1);
			expect(await rows()).toEqual([{ code: "c", f: 5, tag: "neuf" }]);

			const mixed = await runQuery(
				conn,
				'add [{code: "c", f: 7}, {code: "d", f: 8}] into e2u_t on conflict (code) edit set f = 0'
			);
			expect(mixed.rowCount).toBe(2);
			expect(await rows()).toEqual([
				{ code: "c", f: 0, tag: "neuf" },
				{ code: "d", f: 8, tag: "neuf" }
			]);

			const ignored = await runQuery(
				conn,
				'add [{code: "d", f: 1}, {code: "e", f: 2}] into e2u_t on conflict (code) ignore'
			);
			expect(ignored.rowCount).toBe(1);
			expect(await rows()).toEqual([
				{ code: "c", f: 0, tag: "neuf" },
				{ code: "d", f: 8, tag: "neuf" },
				{ code: "e", f: 2, tag: "neuf" }
			]);

			// Toutes les colonnes de la ligne dans l'edit set.
			await runQuery(
				conn,
				'add {code: "g"} into e2u_t on conflict (code) edit set code = "g2"'
			);
			await runQuery(
				conn,
				'transaction { add {code: "t", f: 1} into e2u_t on conflict (code) edit set f = 2 }'
			);
			expect((await rows()).slice(3)).toEqual([
				{ code: "g", tag: "neuf" },
				{ code: "t", f: 1, tag: "neuf" }
			]);
			// Le champ témoin de l'upsert ne reste dans aucun document.
			const all = (await runQuery(conn, "find e2u_t")).rows;
			expect(all.filter((r) => Object.hasOwn(r, "__snql_upsert"))).toEqual([]);
		} finally {
			await runQuery(conn, "drop table e2u_t if exists");
			await conn.close();
		}
	}, 60_000);

	it("clé aliasée `id` et FK : la branche insertion est contrôlée sur ses propres valeurs", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		const drop = async () => {
			for (const t of ["e2u_kid", "e2u_par", "e2u_key"]) {
				await runQuery(conn, `drop table ${t} if exists`);
			}
		};
		try {
			await drop();
			await runQuery(
				conn,
				"create table e2u_key { id: uuid, n: int, primary key (id) }"
			);
			await runQuery(conn, "create table e2u_par { code: text }");
			await runQuery(
				conn,
				"create table e2u_kid { label: text, par: text nullable ref e2u_par.code }"
			);
			const schema = await conn.introspect();

			const upsertKey = (n: number) =>
				runQuery(
					conn,
					`add {id: "${U1}", n: 1} into e2u_key on conflict (id) edit set n = ${n}`,
					schema
				);
			await upsertKey(2);
			expect(
				(await runQuery(conn, "find e2u_key pick id, n", schema)).rows
			).toEqual([{ id: U1, n: 1 }]);
			await upsertKey(2);
			expect(
				(await runQuery(conn, "find e2u_key pick id, n", schema)).rows
			).toEqual([{ id: U1, n: 2 }]);

			await runQuery(conn, 'add {code: "p"} into e2u_par');
			const upsertKid = (par: string) =>
				runQuery(
					conn,
					`add {label: "k", par: "p"} into e2u_kid on conflict (label) edit set par = "${par}"`
				);
			// Insertion : `par` vaut "p", qui existe ; l'edit set n'y est pas appliqué.
			await upsertKid("ghost");
			expect(
				(await runQuery(conn, "find e2u_kid pick label, par")).rows
			).toEqual([{ label: "k", par: "p" }]);
			// Conflit : l'edit set est contrôlé.
			await expect(upsertKid("ghost")).rejects.toThrow(/viole la foreign key/);
			expect(
				(await runQuery(conn, "find e2u_kid pick label, par")).rows
			).toEqual([{ label: "k", par: "p" }]);
		} finally {
			await drop();
			await conn.close();
		}
	}, 60_000);
});
