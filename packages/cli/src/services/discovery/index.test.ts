import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configuredIdentities, discoverDatabases } from ".";
import type { DockerRunner } from "./docker";

let home: string;
let root: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "sqlnest-discover-"));
	root = join(home, "lab");
	mkdirSync(join(root, ".git"), { recursive: true });
	writeFileSync(join(root, "docker-compose.yml"), "services: {}\n");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const COMPOSE = {
	name: "lab",
	services: {
		db: {
			image: "postgres:16-alpine",
			environment: { POSTGRES_USER: "lab", POSTGRES_PASSWORD: "lab" },
			ports: [{ target: 5432, published: "5440" }]
		},
		mongo: { image: "mongo:7", ports: [{ target: 27017, published: "27018" }] }
	}
};

const docker: DockerRunner = async (args) => {
	if (args[0] === "compose") return JSON.stringify(COMPOSE);
	if (args[0] === "ps") {
		return [
			{ ID: "1", Image: "postgres:16-alpine", Ports: "0.0.0.0:5440->5432/tcp" },
			{ ID: "2", Image: "postgres:15", Ports: "0.0.0.0:5433->5432/tcp" }
		]
			.map((l) => JSON.stringify(l))
			.join("\n");
	}
	if (args[0] === "inspect") {
		return JSON.stringify([
			{
				Name: "/lab-db-1",
				Config: {
					Image: "postgres:16-alpine",
					Env: ["POSTGRES_USER=lab", "POSTGRES_PASSWORD=lab"],
					Labels: {
						"com.docker.compose.project": "lab",
						"com.docker.compose.service": "db"
					}
				},
				NetworkSettings: { Ports: { "5432/tcp": [{ HostPort: "5440" }] } }
			},
			{
				Name: "/other-pg",
				Config: { Image: "postgres:15", Env: ["POSTGRES_PASSWORD=x"] },
				NetworkSettings: { Ports: { "5432/tcp": [{ HostPort: "5433" }] } }
			}
		]);
	}
	return undefined;
};

describe("discoverDatabases", () => {
	it("service compose en cours = son conteneur ; arrêté = gardé ; autres conteneurs ensuite", async () => {
		const found = await discoverDatabases({ cwd: root, home, env: {}, docker });
		expect(
			found.servers.map((s) => [s.name, s.port, s.running, s.compose?.service])
		).toEqual([
			["lab-db-1", 5440, true, "db"],
			["mongo", 27018, false, "mongo"],
			["other-pg", 5433, true, undefined]
		]);
	});
});

describe("configuredIdentities", () => {
	it("identité de chaque connexion enregistrée ; une référence illisible est ignorée", () => {
		const identities = configuredIdentities([
			{ name: "chinook-pg", url: "postgres://u:p@127.0.0.1:5433/Chinook" },
			{
				name: "broken",
				urlFrom: { file: join(home, "missing.env"), key: "DATABASE_URL" }
			},
			{ name: "dup", url: "postgresql://x@localhost:5433/chinook" }
		]);
		expect([...identities]).toEqual([
			["postgres|localhost|5433|chinook", "chinook-pg"]
		]);
	});
});
