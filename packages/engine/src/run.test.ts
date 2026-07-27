import type { NativeQuery, PingResult, ResultSet } from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import type { Connection } from "./adapter";
import { UnknownEngineError } from "./errors";
import { runQuery } from "./run";

/** Connexion factice : enregistre la requête reçue, renvoie un ResultSet canné. */
class FakeConnection implements Connection {
	readonly engine: string;
	lastQuery: NativeQuery | undefined;
	readonly result: ResultSet;

	constructor(engine: string, result: ResultSet) {
		this.engine = engine;
		this.result = result;
	}

	ping(): Promise<PingResult> {
		return Promise.resolve({ latencyMs: 0 });
	}

	execute(query: NativeQuery): Promise<ResultSet> {
		this.lastQuery = query;
		return Promise.resolve(this.result);
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}

describe("runQuery", () => {
	it("compile → plan → map → execute (moteur à capacités pleines)", async () => {
		const fake = new FakeConnection("postgres", {
			columns: [{ name: "email" }],
			rows: [{ email: "ada@example.com" }],
			rowCount: 1
		});

		const result = await runQuery(
			fake,
			"get users | where is_active = true | pick email"
		);

		// La requête passée à execute est bien du SQL Postgres ciblant `users`.
		expect(fake.lastQuery?.kind).toBe("sql");
		if (fake.lastQuery?.kind === "sql") {
			expect(fake.lastQuery.text.toLowerCase()).toContain("users");
			expect(fake.lastQuery.text.toLowerCase()).toContain("email");
		}
		expect(result.rows).toEqual([{ email: "ada@example.com" }]);
		expect(result.rowCount).toBe(1);
	});

	it("lève UnknownEngineError pour un moteur inconnu", async () => {
		const fake = new FakeConnection("oracle", {
			columns: [],
			rows: [],
			rowCount: 0
		});
		await expect(runQuery(fake, "get users")).rejects.toBeInstanceOf(
			UnknownEngineError
		);
	});

	it("dispatche une mutation vers execute (UPDATE … RETURNING)", async () => {
		const fake = new FakeConnection("postgres", {
			columns: [{ name: "id" }],
			rows: [{ id: 1 }],
			rowCount: 1
		});
		const rs = await runQuery(
			fake,
			"update users | where id = 1 | set is_active = false"
		);
		expect(fake.lastQuery?.kind).toBe("sql");
		if (fake.lastQuery?.kind === "sql") {
			expect(fake.lastQuery.text).toContain("UPDATE");
			expect(fake.lastQuery.text).toContain("RETURNING");
		}
		expect(rs.rowCount).toBe(1);
	});
});
