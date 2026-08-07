/**
 * Tests unit — `sqlnest revoke-connection`.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	LOCAL_CONNECTIONS_VERSION,
	loadLocalConnections,
	saveLocalConnections
} from "../local-connections";
import type { Prompter } from "../prompts";
import { RevokeConnectionError, revokeConnection } from "./revoke-connection";

function mockPrompter(confirms: boolean[] = []): Prompter {
	const queue = [...confirms];
	return {
		line: vi.fn(async () => {
			throw new Error("line() ne devrait pas être appelé dans revoke");
		}),
		password: vi.fn(async () => {
			throw new Error("password() ne devrait pas être appelé dans revoke");
		}),
		confirm: vi.fn(async () => {
			const next = queue.shift();
			if (next === undefined) {
				throw new Error("mockPrompter: confirm queue vide");
			}
			return next;
		}),
		select: vi.fn(async () => {
			throw new Error("select() ne devrait pas être appelé dans revoke");
		})
	};
}

let tempDir: string;
let out: string[];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "sqlnest-revoke-conn-test-"));
	process.env.SQLNEST_CONFIG_DIR = tempDir;
	out = [];
});

afterEach(() => {
	delete process.env.SQLNEST_CONFIG_DIR;
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("revokeConnection — happy path", () => {
	test("confirm=y → retire l'entrée", async () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [
				{ name: "prod", url: "postgres://p@h/db" },
				{ name: "staging", url: "postgres://s@h/db" }
			]
		});
		const prompter = mockPrompter([true]);

		const res = await revokeConnection({
			name: "prod",
			prompter,
			stdout: (l) => out.push(l)
		});

		expect(res).toEqual({ name: "prod" });
		const file = loadLocalConnections();
		expect(file?.connections.length).toBe(1);
		expect(file?.connections[0]?.name).toBe("staging");
		expect(out.some((l) => /retirée/.test(l))).toBe(true);
	});

	test("--yes → skip confirm", async () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://p@h/db" }]
		});
		const prompter = mockPrompter();

		await revokeConnection({
			name: "prod",
			yes: true,
			prompter,
			stdout: (l) => out.push(l)
		});

		expect(prompter.confirm).not.toHaveBeenCalled();
		expect(loadLocalConnections()?.connections.length).toBe(0);
	});
});

describe("revokeConnection — refus / erreurs", () => {
	test("confirm=n → throw cancelled, fichier intact", async () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://p@h/db" }]
		});
		const prompter = mockPrompter([false]);

		await expect(
			revokeConnection({
				name: "prod",
				prompter,
				stdout: (l) => out.push(l)
			})
		).rejects.toMatchObject({
			name: "RevokeConnectionError",
			kind: "cancelled"
		});

		expect(loadLocalConnections()?.connections.length).toBe(1);
	});

	test("entrée inexistante → throw not-found (avant confirm)", async () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://p@h/db" }]
		});
		const prompter = mockPrompter([]);

		await expect(
			revokeConnection({
				name: "ghost",
				prompter,
				stdout: (l) => out.push(l)
			})
		).rejects.toBeInstanceOf(RevokeConnectionError);

		expect(prompter.confirm).not.toHaveBeenCalled();
		expect(loadLocalConnections()?.connections.length).toBe(1);
	});

	test("fichier absent → throw not-found", async () => {
		const prompter = mockPrompter([]);

		await expect(
			revokeConnection({
				name: "prod",
				prompter,
				stdout: (l) => out.push(l)
			})
		).rejects.toMatchObject({
			name: "RevokeConnectionError",
			kind: "not-found"
		});
	});
});
