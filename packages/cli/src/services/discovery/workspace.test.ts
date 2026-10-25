import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceDirs } from "./workspace";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sqlnest-workspace-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function write(path: string, content = ""): void {
	const file = join(root, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

describe("workspaceDirs", () => {
	it("pnpm-workspace.yaml : motifs, `*`, exclusions `!`", () => {
		write(
			"pnpm-workspace.yaml",
			[
				"engineStrict: true",
				"",
				"packages:",
				"  - common/*",
				'  - "backend"',
				"  - '!common/legacy'",
				"",
				"catalog:",
				"  eslint: ^9"
			].join("\n")
		);
		mkdirSync(join(root, "common", "ui"), { recursive: true });
		mkdirSync(join(root, "common", "utils"), { recursive: true });
		mkdirSync(join(root, "backend"));
		mkdirSync(join(root, "catalog"));
		expect(workspaceDirs(root)).toEqual([
			join(root, "common", "ui"),
			join(root, "common", "utils"),
			join(root, "backend")
		]);
	});

	it("package.json `workspaces` (tableau ou { packages }), Cargo `members`", () => {
		write(
			"package.json",
			JSON.stringify({ workspaces: { packages: ["apps/*"] } })
		);
		mkdirSync(join(root, "apps", "api"), { recursive: true });
		write("Cargo.toml", '[workspace]\nmembers = [\n  "crates/db",\n]\n');
		mkdirSync(join(root, "crates", "db"), { recursive: true });
		expect(workspaceDirs(root)).toEqual([
			join(root, "apps", "api"),
			join(root, "crates", "db")
		]);
	});

	it("sans déclaration : sous-dossiers à manifeste, .env, Prisma ou compose ; node_modules et cachés ignorés", () => {
		write("backend/.env", "DATABASE_URL=postgres://u@localhost/app");
		write("frontend/package.json", "{}");
		write("infra/docker-compose.yml", "services: {}");
		write("docs/README.md");
		write("node_modules/pkg/package.json", "{}");
		write(".github/package.json", "{}");
		expect(workspaceDirs(root)).toEqual([
			join(root, "backend"),
			join(root, "frontend"),
			join(root, "infra")
		]);
	});
});
