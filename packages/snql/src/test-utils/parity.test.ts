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
	it("subquery Mongo → planner_subquery_unsupported", () => {
		const err = assertMongoRefused(
			"find users where id in (find orders pick user_id)",
			"planner_subquery_unsupported"
		);
		expect(err).toBeInstanceOf(SnqlError);
		expect(err.code).toBe("planner_subquery_unsupported");
	});

	it("write-join Mongo → planner_write_join_unsupported", () => {
		const err = assertMongoRefused(
			"update orders with one users as u on user_id = u.id set discount = 0.1",
			"planner_write_join_unsupported"
		);
		expect(err.code).toBe("planner_write_join_unsupported");
	});

	it("insert-select Mongo → planner_insert_select_unsupported", () => {
		const err = assertMongoRefused(
			"add (find users pick id, email) into archive",
			"planner_insert_select_unsupported"
		);
		expect(err.code).toBe("planner_insert_select_unsupported");
	});

	it("let Mongo → planner_let_unsupported", () => {
		const err = assertMongoRefused(
			"let old = find users where inactive = true pick id; find old pick id",
			"planner_let_unsupported"
		);
		expect(err.code).toBe("planner_let_unsupported");
	});

	it("échec descriptif si aucune erreur levée", () => {
		expect(() =>
			assertMongoRefused("find users pick id", "planner_subquery_unsupported")
		).toThrow(/aucune erreur levée/);
	});

	it("échec descriptif si code différent de l'attendu", () => {
		expect(() =>
			assertMongoRefused(
				"find users where id in (find orders pick user_id)",
				"planner_let_unsupported"
			)
		).toThrow(
			/code attendu 'planner_let_unsupported', reçu 'planner_subquery_unsupported'/
		);
	});
});
