import type {
	NativeQuery,
	PingResult,
	ResultSet,
	SchemaModel
} from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import type { Connection } from "./adapter";
import {
	EngineConnectionError,
	EngineExecutionError,
	UnknownEngineError
} from "./errors";
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

	introspect(): Promise<SchemaModel> {
		return Promise.resolve({
			engine: this.engine,
			collections: [],
			relations: []
		});
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
			"get users where is_active = true pick email"
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
			"update users where id = 1 set is_active = false"
		);
		expect(fake.lastQuery?.kind).toBe("sql");
		if (fake.lastQuery?.kind === "sql") {
			expect(fake.lastQuery.text).toContain("UPDATE");
			expect(fake.lastQuery.text).toContain("RETURNING");
		}
		expect(rs.rowCount).toBe(1);
	});
});

describe("runQuery — add index Postgres en échec (ADR-029 D18)", () => {
	const SRC = "add unique index (name) into agency";

	/**
	 * Le `CREATE INDEX CONCURRENTLY` échoue sur `failure`, le contrôle du
	 * catalogue trouve l'index resté invalide, le retrait échoue sur `dropFailure`.
	 */
	function failing(failure: Error, dropFailure?: Error) {
		const texts: string[] = [];
		const conn = {
			engine: "postgres",
			namespace: "public",
			execute: async (query: NativeQuery): Promise<ResultSet> => {
				texts.push(query.kind === "sql" ? query.text : query.kind);
				if (texts.length === 1) throw failure;
				if (texts.length === 3 && dropFailure !== undefined) throw dropFailure;
				const rows = texts.length === 2 ? [{}] : [];
				return { columns: [], rows, rowCount: rows.length };
			}
		} as unknown as Connection;
		return { conn, texts };
	}

	const duplicates = () =>
		new EngineExecutionError("could not create unique index", {
			pgError: { message: "could not create unique index", code: "23505" }
		});

	it("l'index invalide est retiré, puis l'erreur d'origine rendue telle quelle", async () => {
		const failure = duplicates();
		const { conn, texts } = failing(failure);
		await expect(runQuery(conn, SRC)).rejects.toBe(failure);
		expect(texts[0]).toBe(
			'CREATE UNIQUE INDEX CONCURRENTLY "unique_agency_name" ON "agency" ("name")'
		);
		expect(texts[2]).toBe(
			'DROP INDEX CONCURRENTLY IF EXISTS "unique_agency_name"'
		);
	});

	it("retrait en échec : ajouté au message, détail Postgres gardé", async () => {
		const failure = duplicates();
		const { conn } = failing(
			failure,
			new Error("canceling statement due to lock timeout")
		);
		const err = await runQuery(conn, SRC).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(EngineExecutionError);
		expect((err as EngineExecutionError).message).toBe(
			"could not create unique index\n(Index invalide non retiré : canceling statement due to lock timeout)"
		);
		expect((err as EngineExecutionError).pgError).toBe(failure.pgError);
	});

	it("requête qui n'a pas atteint la base : rien n'est tenté", async () => {
		const failure = new EngineConnectionError(
			"Exécution Postgres : acquisition d'une connexion échouée"
		);
		const { conn, texts } = failing(failure);
		await expect(runQuery(conn, SRC)).rejects.toBe(failure);
		expect(texts).toHaveLength(1);
	});
});
