/**
 * Tests unit — dispatcher `runCli`.
 *
 * Utilise l'injection totale des commands + stdout/stderr pour éviter
 * tout side-effect. Aucun test filesystem/network réel.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runCli } from "./cli";
import { ConnectError } from "./commands/connect";
import { addLocalConnection } from "./local-connections";

// Isolation obligatoire : `runCli connect` (via `resolveCliConnectionName`
// C.13) lit `~/.sqlnest/local-connections.toml`. Sans isolation, un dev qui
// a des DSN locales verrait le CLI prompt (≥2 entrées) → tests bloqués
// en TTY-wait. On pointe `SQLNEST_CONFIG_DIR` vers un tmpdir vide.
let originalConfigDir: string | undefined;
let tmpConfigDir: string;
beforeEach(() => {
	originalConfigDir = process.env.SQLNEST_CONFIG_DIR;
	tmpConfigDir = mkdtempSync(join(tmpdir(), "sqlnest-cli-test-"));
	process.env.SQLNEST_CONFIG_DIR = tmpConfigDir;
});
afterEach(() => {
	if (originalConfigDir === undefined) {
		delete process.env.SQLNEST_CONFIG_DIR;
	} else {
		process.env.SQLNEST_CONFIG_DIR = originalConfigDir;
	}
	rmSync(tmpConfigDir, { recursive: true, force: true });
});

function captureIO(): {
	stdout: (line: string) => void;
	stderr: (line: string) => void;
	out: string[];
	err: string[];
} {
	const out: string[] = [];
	const err: string[] = [];
	return {
		stdout: (line: string) => out.push(line),
		stderr: (line: string) => err.push(line),
		out,
		err
	};
}

describe("runCli — help & version", () => {
	test("argv vide → affiche l'aide + exit 0", async () => {
		const io = captureIO();
		const code = await runCli([], { stdout: io.stdout, stderr: io.stderr });
		expect(code).toBe(0);
		expect(io.out.join("\n")).toMatch(/Usage/);
	});

	test("--help → 0", async () => {
		const io = captureIO();
		const code = await runCli(["--help"], {
			stdout: io.stdout,
			stderr: io.stderr
		});
		expect(code).toBe(0);
	});

	test("-h → 0", async () => {
		const io = captureIO();
		const code = await runCli(["-h"], { stdout: io.stdout, stderr: io.stderr });
		expect(code).toBe(0);
	});

	test("--version → affiche la version", async () => {
		const io = captureIO();
		const code = await runCli(["--version"], {
			stdout: io.stdout,
			stderr: io.stderr
		});
		expect(code).toBe(0);
		expect(io.out.join("")).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("commande inconnue → 2 + help sur stderr", async () => {
		const io = captureIO();
		const code = await runCli(["nope"], {
			stdout: io.stdout,
			stderr: io.stderr
		});
		expect(code).toBe(2);
		expect(io.err.join("\n")).toMatch(/inconnue/);
	});
});

describe("runCli — connect (device flow)", () => {
	test("happy path → 0 + message succès", async () => {
		const io = captureIO();
		const connectFn = vi.fn().mockResolvedValue({
			tunnelId: "11111111-1111-1111-1111-111111111111",
			connectionId: "22222222-2222-2222-2222-222222222222",
			sessionToken: `tn_${"a".repeat(64)}`,
			expiresAt: new Date(),
			connectionName: "alice-mac"
		});

		const code = await runCli(["connect"], {
			stdout: io.stdout,
			stderr: io.stderr,
			env: {
				SQLNEST_API_URL: "http://localhost:4000",
				SQLNEST_FRONTEND_URL: "http://localhost:3000"
			},
			// biome-ignore lint/suspicious/noExplicitAny: mock d'injection
			connectFn: connectFn as any,
			// Le CLI passe en `serveTunnel` (blocking) après un pairing
			// réussi — on stub le loop pour retourner immédiatement.
			// biome-ignore lint/suspicious/noExplicitAny: mock stub
			serveTunnelFn: (async () => 0) as any
		});

		expect(code).toBe(0);
		expect(connectFn).toHaveBeenCalledTimes(1);
		const opts = connectFn.mock.calls[0]?.[0];
		expect(opts.baseUrl).toBe("http://localhost:4000");
		expect(opts.frontendUrl).toBe("http://localhost:3000");
		expect(opts.openBrowserOnDisplay).toBe(true);
		expect(io.out.some((l) => l.includes("alice-mac"))).toBe(true);
	});

	test("--no-browser → openBrowserOnDisplay: false", async () => {
		const io = captureIO();
		const connectFn = vi.fn().mockResolvedValue({
			tunnelId: "id",
			connectionId: "c",
			sessionToken: "tn_x",
			expiresAt: new Date(),
			connectionName: "x"
		});
		const code = await runCli(["connect", "--no-browser"], {
			stdout: io.stdout,
			stderr: io.stderr,
			// biome-ignore lint/suspicious/noExplicitAny: mock
			connectFn: connectFn as any,
			// biome-ignore lint/suspicious/noExplicitAny: mock stub
			serveTunnelFn: (async () => 0) as any
		});
		expect(code).toBe(0);
		expect(connectFn.mock.calls[0]?.[0].openBrowserOnDisplay).toBe(false);
	});

	test("flag inconnu → 2", async () => {
		const io = captureIO();
		const code = await runCli(["connect", "--unknown"], {
			stdout: io.stdout,
			stderr: io.stderr
		});
		expect(code).toBe(2);
	});

	test("ConnectError timeout → 1 + message", async () => {
		const io = captureIO();
		const connectFn = vi.fn().mockRejectedValue(new ConnectError("timeout"));
		const code = await runCli(["connect"], {
			stdout: io.stdout,
			stderr: io.stderr,
			// biome-ignore lint/suspicious/noExplicitAny: mock
			connectFn: connectFn as any,
			// biome-ignore lint/suspicious/noExplicitAny: mock stub
			serveTunnelFn: (async () => 0) as any
		});
		expect(code).toBe(1);
		expect(io.err.some((l) => /Timeout/i.test(l))).toBe(true);
	});

	test("ConnectError expired → message spécifique", async () => {
		const io = captureIO();
		const connectFn = vi.fn().mockRejectedValue(new ConnectError("expired"));
		const code = await runCli(["connect"], {
			stdout: io.stdout,
			stderr: io.stderr,
			// biome-ignore lint/suspicious/noExplicitAny: mock
			connectFn: connectFn as any,
			// biome-ignore lint/suspicious/noExplicitAny: mock stub
			serveTunnelFn: (async () => 0) as any
		});
		expect(code).toBe(1);
		expect(io.err.some((l) => /expiré|expire/i.test(l))).toBe(true);
	});
});

describe("runCli — connect: sélection DSN locale (C.13)", () => {
	test("0 DSN locale → cliConnectionName null (compat legacy)", async () => {
		const io = captureIO();
		const connectFn = vi.fn().mockResolvedValue({
			tunnelId: "id",
			connectionId: "c",
			sessionToken: "tn_x",
			expiresAt: new Date(),
			connectionName: "x"
		});
		await runCli(["connect"], {
			stdout: io.stdout,
			stderr: io.stderr,
			// biome-ignore lint/suspicious/noExplicitAny: mock
			connectFn: connectFn as any,
			// biome-ignore lint/suspicious/noExplicitAny: mock stub
			serveTunnelFn: (async () => 0) as any
		});
		expect(connectFn.mock.calls[0]?.[0].cliConnectionName).toBeNull();
	});

	test("1 seule DSN locale → sélection auto (pas de prompt)", async () => {
		addLocalConnection({
			name: "apollon",
			url: "postgres://user:pass@localhost:5432/apollon"
		});
		const io = captureIO();
		const connectFn = vi.fn().mockResolvedValue({
			tunnelId: "id",
			connectionId: "c",
			sessionToken: "tn_x",
			expiresAt: new Date(),
			connectionName: "apollon"
		});
		await runCli(["connect"], {
			stdout: io.stdout,
			stderr: io.stderr,
			// biome-ignore lint/suspicious/noExplicitAny: mock
			connectFn: connectFn as any,
			// biome-ignore lint/suspicious/noExplicitAny: mock stub
			serveTunnelFn: (async () => 0) as any
		});
		expect(connectFn.mock.calls[0]?.[0].cliConnectionName).toBe("apollon");
	});

	test("--connection <name> explicite → pris tel quel", async () => {
		addLocalConnection({
			name: "apollon",
			url: "postgres://x/apollon"
		});
		addLocalConnection({
			name: "delphi",
			url: "postgres://x/delphi"
		});
		const io = captureIO();
		const connectFn = vi.fn().mockResolvedValue({
			tunnelId: "id",
			connectionId: "c",
			sessionToken: "tn_x",
			expiresAt: new Date(),
			connectionName: "delphi"
		});
		await runCli(["connect", "--connection", "delphi"], {
			stdout: io.stdout,
			stderr: io.stderr,
			// biome-ignore lint/suspicious/noExplicitAny: mock
			connectFn: connectFn as any,
			// biome-ignore lint/suspicious/noExplicitAny: mock stub
			serveTunnelFn: (async () => 0) as any
		});
		expect(connectFn.mock.calls[0]?.[0].cliConnectionName).toBe("delphi");
	});

	test("--connection <inconnu> → 2 + message d'erreur listant les DSN connues", async () => {
		addLocalConnection({ name: "apollon", url: "postgres://x/apollon" });
		addLocalConnection({ name: "delphi", url: "postgres://x/delphi" });
		const io = captureIO();
		const code = await runCli(["connect", "--connection", "olympia"], {
			stdout: io.stdout,
			stderr: io.stderr
		});
		expect(code).toBe(2);
		expect(io.err.some((l) => /olympia/.test(l))).toBe(true);
		expect(io.err.some((l) => /apollon.*delphi|delphi.*apollon/.test(l))).toBe(
			true
		);
	});

	test("≥2 DSN + prompter injecté → prompt appelé, réponse '2' → 2e DSN", async () => {
		addLocalConnection({ name: "apollon", url: "postgres://x/apollon" });
		addLocalConnection({ name: "delphi", url: "postgres://x/delphi" });
		const io = captureIO();
		const connectFn = vi.fn().mockResolvedValue({
			tunnelId: "id",
			connectionId: "c",
			sessionToken: "tn_x",
			expiresAt: new Date(),
			connectionName: "delphi"
		});
		const line = vi.fn().mockResolvedValue("2");
		await runCli(["connect"], {
			stdout: io.stdout,
			stderr: io.stderr,
			prompter: {
				line,
				password: async () => "",
				confirm: async () => false
			},
			// biome-ignore lint/suspicious/noExplicitAny: mock
			connectFn: connectFn as any,
			// biome-ignore lint/suspicious/noExplicitAny: mock stub
			serveTunnelFn: (async () => 0) as any
		});
		expect(line).toHaveBeenCalledOnce();
		expect(connectFn.mock.calls[0]?.[0].cliConnectionName).toBe("delphi");
	});
});

describe("runCli — connect --token (CI)", () => {
	test("--token sans --name → 2 + usage error", async () => {
		const io = captureIO();
		const code = await runCli(["connect", "--token", "sn_xxx"], {
			stdout: io.stdout,
			stderr: io.stderr
		});
		expect(code).toBe(2);
		expect(io.err.some((l) => /--name|requis/i.test(l))).toBe(true);
	});

	test("--token + --name → appelle connectWithTokenFn", async () => {
		const io = captureIO();
		const stub = vi.fn().mockResolvedValue({
			tunnelId: "id",
			connectionId: "c",
			sessionToken: "tn_x",
			expiresAt: new Date(),
			connectionName: "ci-runner"
		});
		const bearer = `sn_${"a".repeat(64)}`;
		const code = await runCli(
			["connect", "--token", bearer, "--name", "ci-runner"],
			{
				stdout: io.stdout,
				stderr: io.stderr,
				// biome-ignore lint/suspicious/noExplicitAny: mock
				connectWithTokenFn: stub as any,
				// biome-ignore lint/suspicious/noExplicitAny: mock stub
				serveTunnelFn: (async () => 0) as any
			}
		);
		expect(code).toBe(0);
		const opts = stub.mock.calls[0]?.[0];
		expect(opts.bearerToken).toBe(bearer);
		expect(opts.deviceName).toBe("ci-runner");
		expect(io.out.some((l) => /CI|ci-runner/i.test(l))).toBe(true);
	});
});

describe("runCli — ping", () => {
	test("ping sans --tunnel → 2", async () => {
		const io = captureIO();
		const code = await runCli(["ping"], {
			stdout: io.stdout,
			stderr: io.stderr
		});
		expect(code).toBe(2);
		expect(io.err.some((l) => /tunnel/i.test(l))).toBe(true);
	});

	test("ping --tunnel <name> → 0 + affiche latency + source", async () => {
		const io = captureIO();
		const stub = vi.fn().mockResolvedValue({
			latencyMs: 7,
			source: "env-per-tunnel",
			serverVersion: "16.2",
			collectionCount: 7
		});
		const code = await runCli(["ping", "--tunnel", "shop"], {
			stdout: io.stdout,
			stderr: io.stderr,
			// biome-ignore lint/suspicious/noExplicitAny: mock
			pingFn: stub as any
		});
		expect(code).toBe(0);
		expect(stub).toHaveBeenCalledTimes(1);
		expect(stub.mock.calls[0]?.[0].tunnelName).toBe("shop");
		expect(io.out.some((l) => /7 ms/i.test(l))).toBe(true);
		expect(io.out.some((l) => /env-per-tunnel/i.test(l))).toBe(true);
		expect(io.out.some((l) => /PG 16\.2/i.test(l))).toBe(true);
		expect(io.out.some((l) => /7 collections/i.test(l))).toBe(true);
	});

	test("ping échoue → 1 + message erreur", async () => {
		const io = captureIO();
		const stub = vi.fn().mockRejectedValue(new Error("connection refused"));
		const code = await runCli(["ping", "--tunnel", "prod"], {
			stdout: io.stdout,
			stderr: io.stderr,
			// biome-ignore lint/suspicious/noExplicitAny: mock
			pingFn: stub as any
		});
		expect(code).toBe(1);
		expect(io.err.some((l) => /connection refused/.test(l))).toBe(true);
	});
});

describe("runCli — logout", () => {
	test("logout sans --all ni --tunnel → 2", async () => {
		const io = captureIO();
		const code = await runCli(["logout"], {
			stdout: io.stdout,
			stderr: io.stderr
		});
		expect(code).toBe(2);
	});

	test("logout --all → 0 + message avec count", async () => {
		const io = captureIO();
		const stub = vi.fn().mockReturnValue({ removed: 3 });
		const code = await runCli(["logout", "--all"], {
			stdout: io.stdout,
			stderr: io.stderr,
			// biome-ignore lint/suspicious/noExplicitAny: mock
			logoutFn: stub as any
		});
		expect(code).toBe(0);
		expect(stub).toHaveBeenCalledWith({ all: true });
		expect(io.out.some((l) => /3/.test(l) && /retir/i.test(l))).toBe(true);
	});

	test("logout --tunnel <id> → 0 + message", async () => {
		const io = captureIO();
		const stub = vi.fn().mockReturnValue({ removed: 1 });
		const code = await runCli(["logout", "--tunnel", "abcd-1234-abcd-1234"], {
			stdout: io.stdout,
			stderr: io.stderr,
			// biome-ignore lint/suspicious/noExplicitAny: mock
			logoutFn: stub as any
		});
		expect(code).toBe(0);
		expect(stub).toHaveBeenCalledWith({ tunnelId: "abcd-1234-abcd-1234" });
	});

	test("logout throws → 1", async () => {
		const io = captureIO();
		const stub = vi.fn().mockImplementation(() => {
			throw new Error("filesystem read-only");
		});
		const code = await runCli(["logout", "--all"], {
			stdout: io.stdout,
			stderr: io.stderr,
			// biome-ignore lint/suspicious/noExplicitAny: mock
			logoutFn: stub as any
		});
		expect(code).toBe(1);
	});
});
