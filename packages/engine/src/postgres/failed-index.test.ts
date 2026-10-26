import {
	type DDLPlan,
	type DDLStatement,
	lowerDDL,
	type NativeQuery,
	parse,
	type ResultSet,
	type SchemaModel,
	tokenize
} from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import type { Connection } from "../adapter";
import { EngineExecutionError } from "../errors";
import { dropFailedIndex } from "./failed-index";

const plan = (src: string): DDLPlan =>
	lowerDDL(parse(tokenize(src)) as DDLStatement);

const ADD_UNIQUE = plan("add unique index (name) into agency");

/** Le contrôle du catalogue rend `left` lignes ; les requêtes sont gardées. */
function connection(
	left: number,
	extra: Partial<Connection> = {}
): Connection & { readonly queries: NativeQuery[] } {
	const queries: NativeQuery[] = [];
	return {
		engine: "postgres",
		namespace: "app",
		queries,
		execute: async (query: NativeQuery): Promise<ResultSet> => {
			queries.push(query);
			const rows = queries.length === 1 ? Array(left).fill({}) : [];
			return { columns: [], rows, rowCount: rows.length };
		},
		...extra
	} as unknown as Connection & { readonly queries: NativeQuery[] };
}

const duplicates = new EngineExecutionError("could not create unique index", {
	pgError: { message: "could not create unique index", code: "23505" }
});

const texts = (queries: readonly NativeQuery[]) =>
	queries.map((q) => (q.kind === "sql" ? q.text : q.kind));

describe("dropFailedIndex (ADR-029 D18)", () => {
	it("index resté invalide : contrôlé dans le schéma de la connexion, puis retiré sans verrou exclusif", async () => {
		const conn = connection(1);
		await dropFailedIndex(conn, ADD_UNIQUE, undefined, duplicates);
		expect(conn.queries[0]).toMatchObject({
			kind: "sql",
			params: ["app", "agency", "unique_agency_name"]
		});
		expect(texts(conn.queries)[1]).toBe(
			'DROP INDEX CONCURRENTLY IF EXISTS "unique_agency_name"'
		);
	});

	it("aucun index invalide à retirer (absent, valide, ou construit par une autre session) : rien n'est retiré", async () => {
		const conn = connection(0);
		await dropFailedIndex(conn, ADD_UNIQUE, undefined, duplicates);
		expect(conn.queries).toHaveLength(1);
	});

	it("schéma de connexion inconnu : public, comme l'introspection", async () => {
		const conn = connection(0, { namespace: undefined });
		await dropFailedIndex(conn, ADD_UNIQUE, undefined, duplicates);
		expect(conn.queries[0]).toMatchObject({
			params: ["public", "agency", "unique_agency_name"]
		});
	});

	it("index déjà là avant l'essai, même invalide : pas le sien, rien n'est touché", async () => {
		const before: SchemaModel = {
			engine: "postgres",
			collections: [
				{
					name: "agency",
					source: "declared",
					fields: [],
					indexes: [
						{
							name: "unique_agency_name",
							columns: ["name"],
							unique: true,
							valid: false
						}
					]
				}
			],
			relations: []
		};
		const conn = connection(1);
		await dropFailedIndex(conn, ADD_UNIQUE, before, duplicates);
		expect(conn.queries).toEqual([]);
	});

	it("nom déjà pris à l'essai (42P07) : l'essai n'a rien créé, rien n'est touché", async () => {
		const conn = connection(1);
		await dropFailedIndex(
			conn,
			ADD_UNIQUE,
			undefined,
			new EngineExecutionError('relation "unique_agency_name" already exists', {
				pgError: { message: "already exists", code: "42P07" }
			})
		);
		expect(conn.queries).toEqual([]);
	});

	it("échec venu d'un outil (sans SQLSTATE) : contrôle et retrait", async () => {
		const conn = connection(1);
		await dropFailedIndex(
			conn,
			ADD_UNIQUE,
			undefined,
			new Error("P3018 : doublons")
		);
		expect(conn.queries).toHaveLength(2);
	});

	it("hors du cas : index sans CONCURRENTLY, autre moteur, autre DDL", async () => {
		const sequential = lowerDDL(
			parse(tokenize("add index (name) into agency")) as DDLStatement,
			undefined,
			{ concurrentIndex: false }
		);
		for (const [conn, p] of [
			[connection(1), sequential],
			[connection(1, { engine: "mssql" }), ADD_UNIQUE],
			[connection(1), plan("add column nickname string nullable into agency")]
		] as const) {
			await dropFailedIndex(conn, p, undefined, duplicates);
			expect(conn.queries).toEqual([]);
		}
	});
});
