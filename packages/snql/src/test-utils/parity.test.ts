import { describe, expect, it } from "vitest";
import { SnqlError } from "../diagnostics";
import {
	assertMongoPipeline,
	assertMongoRefused,
	mongoPipeline,
	mongoSql,
	mongoWrite,
	pgSql
} from "./parity";

describe("pgSql (ADR-024 D11)", () => {
	it("SELECT simple → SQL text + params", () => {
		const { text, params } = pgSql("find users pick id, email");
		expect(text).toContain("FROM");
		expect(text).toContain("users");
		expect(params).toEqual([]);
	});

	it("INSERT — dispatch via lowerMutation + mapMutation", () => {
		const { text } = pgSql('add {id: 1, name: "a"} into users');
		expect(text).toContain("INSERT");
		expect(text).toContain("users");
	});

	it("UPDATE avec where", () => {
		const { text } = pgSql('update users where id = 1 set name = "z"');
		expect(text).toContain("UPDATE");
	});

	it("DELETE avec where", () => {
		const { text } = pgSql("remove from users where id = 1");
		expect(text).toContain("DELETE");
	});
});

describe("mongoSql / mongoPipeline (ADR-024 D11)", () => {
	it("SELECT → NativeQuery kind='mongo' avec pipeline", () => {
		const native = mongoSql("find users pick id");
		expect(native.kind).toBe("mongo");
	});

	it("mongoPipeline extrait le pipeline stages directement", () => {
		const pipeline = mongoPipeline("find users pick id");
		expect(Array.isArray(pipeline)).toBe(true);
		expect(pipeline.length).toBeGreaterThan(0);
	});

	it("assertMongoPipeline (alias mongoPipeline) — SELECT filtered", () => {
		const pipeline = assertMongoPipeline("find users where id = 1 pick id");
		expect(pipeline.some((s) => "$match" in s)).toBe(true);
	});

	it("mongoWrite — INSERT", () => {
		const write = mongoWrite('add {name: "a"} into users');
		expect(write.kind).toBe("mongo-write");
		expect(write.op).toBe("insert");
	});

	it("mongoWrite — UPDATE avec where", () => {
		const write = mongoWrite('update users where id = 1 set name = "z"');
		expect(write.kind).toBe("mongo-write");
		expect(write.op).toBe("update");
	});
});

describe("assertMongoRefused (ADR-024 D11)", () => {
	it("correlated subquery nested 2+ niveaux Mongo → refus MVP", () => {
		// PA/1 : correlated 1 niveau désormais liftée en $lookup{let,pipeline}
		// sur Mongo. Nested 2+ niveaux reste hors scope MVP → refus dédié.
		const err = assertMongoRefused(
			"find users as u where exists (find orders as o where exists (find items as i where i.tag = u.name))",
			"planner_correlated_subquery_nested_v3"
		);
		expect(err).toBeInstanceOf(SnqlError);
		expect(err.code).toBe("planner_correlated_subquery_nested_v3");
	});

	it("write-join Mongo (PM/4) → codegen aggregate+$merge, plus de refus", () => {
		// Depuis PM/4 : Mongo supporte write-join via aggregate + $merge natif.
		// L'ancien planner_write_join_unsupported n'est plus levé.
		const write = mongoWrite(
			"update orders with one users as u on user_id = u.id set discount = 0.1"
		);
		expect(write.op).toBe("update-agg-merge");
	});

	it("insert-select Mongo (PM/5) → codegen aggregate+$merge, plus de refus", () => {
		const write = mongoWrite("add (find users pick id, email) into archive");
		expect(write.op).toBe("insert-select-agg-merge");
	});

	it("let Mongo (PM/3) → matérialisation runtime, pas de codegen", () => {
		// Depuis PM/3 : Mongo a cte capability, exécution via materializeLet
		// runtime (pas codegen). Le parity helper le signale explicitement pour
		// que le caller sache qu'il faut passer par runQuery + Connection.
		const err = assertMongoRefused(
			"let old = find users where inactive = true pick id; find old pick id",
			"parity_helper_runtime_materialized"
		);
		expect(err.code).toBe("parity_helper_runtime_materialized");
		expect(err.message).toContain("runtime");
	});

	it("échec descriptif si aucune erreur levée", () => {
		expect(() =>
			assertMongoRefused("find users pick id", "planner_subquery_unsupported")
		).toThrow(/aucune erreur levée/);
	});

	it("échec descriptif si code différent de l'attendu", () => {
		expect(() =>
			assertMongoRefused(
				"find users as u where exists (find orders as o where exists (find items as i where i.tag = u.name))",
				"planner_let_unsupported"
			)
		).toThrow(
			/code attendu 'planner_let_unsupported', reçu 'planner_correlated_subquery_nested_v3'/
		);
	});
});
