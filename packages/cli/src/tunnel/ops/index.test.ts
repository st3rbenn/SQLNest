import type { Connection } from "@sqlnest/engine";
import type { SchemaModel } from "@sqlnest/snql";
import { describe, expect, it, vi } from "vitest";
import { createSchemaCache, dispatchOp } from "./index";

const SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [],
	relations: []
};

function fakeConnection(overrides: Partial<Connection> = {}): Connection {
	return {
		engine: "postgres",
		ping: vi.fn(async () => ({ latencyMs: 3, serverVersion: "16" })),
		introspect: vi.fn(async () => SCHEMA),
		close: vi.fn(async () => undefined),
		...overrides
	} as unknown as Connection;
}

function target(conn: Connection) {
	const open = vi.fn(async () => conn);
	return {
		open,
		connectionName: "apollon",
		env: {},
		schema: createSchemaCache()
	};
}

describe("dispatchOp", () => {
	it("op inconnue → échec, aucune connexion ouverte", async () => {
		const conn = fakeConnection();
		const t = target(conn);
		expect(await dispatchOp({ op: "nope" } as never, t)).toEqual({
			ok: false,
			error: "op inconnue"
		});
		expect(t.open).not.toHaveBeenCalled();
	});

	it("ping : connexion ouverte à la demande, fermée après l'op", async () => {
		const conn = fakeConnection();
		const t = target(conn);
		expect(await dispatchOp({ op: "ping" }, t)).toEqual({
			ok: true,
			data: { latencyMs: 3, serverVersion: "16" }
		});
		expect(t.open).toHaveBeenCalledWith("apollon", {});
		expect(conn.close).toHaveBeenCalledOnce();
	});

	it("introspect remplit le cache de schéma", async () => {
		const t = target(fakeConnection());
		await dispatchOp({ op: "introspect" }, t);
		expect(t.schema.get()).toBe(SCHEMA);
	});

	it("une erreur remonte, la connexion est fermée quand même", async () => {
		const conn = fakeConnection({
			ping: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			})
		});
		await expect(dispatchOp({ op: "ping" }, target(conn))).rejects.toThrow(
			"ECONNREFUSED"
		);
		expect(conn.close).toHaveBeenCalledOnce();
	});
});
