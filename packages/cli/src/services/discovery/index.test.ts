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

/** `docker` qui rend le compose ci-dessus et ces conteneurs. */
function dockerWith(inspected: readonly object[]): DockerRunner {
	return async (args) => {
		if (args[0] === "compose") return JSON.stringify(COMPOSE);
		if (args[0] === "ps") {
			return inspected
				.map((_, i) =>
					JSON.stringify({ ID: String(i), Image: "postgres:16", Ports: "" })
				)
				.join("\n");
		}
		if (args[0] === "inspect") return JSON.stringify(inspected);
		return undefined;
	};
}

const LAB_DB = {
	Name: "/lab-db-1",
	State: { Running: true },
	Config: {
		Image: "postgres:16-alpine",
		Env: ["POSTGRES_USER=lab", "POSTGRES_PASSWORD=lab"],
		Labels: {
			"com.docker.compose.project": "lab",
			"com.docker.compose.service": "db"
		}
	},
	NetworkSettings: { Ports: { "5432/tcp": [{ HostPort: "5440" }] } }
};
const OTHER_PG = {
	Name: "/other-pg",
	State: { Running: true },
	Config: { Image: "postgres:15", Env: ["POSTGRES_PASSWORD=x"] },
	NetworkSettings: { Ports: { "5432/tcp": [{ HostPort: "5433" }] } }
};
const OLD_PG = {
	Name: "/old-pg",
	State: { Running: false },
	Config: { Image: "postgres:15", Env: [] },
	HostConfig: { PortBindings: { "5432/tcp": [{ HostPort: "5450" }] } }
};

const closed = async () => false;

describe("discoverDatabases", () => {
	it("serveurs du projet : service compose en cours = son conteneur, arrêté gardé ; autres en cours d'abord", async () => {
		const found = await discoverDatabases({
			cwd: root,
			home,
			env: {},
			docker: dockerWith([OLD_PG, LAB_DB, OTHER_PG]),
			portOpen: closed
		});
		expect(
			found.projectServers.map((s) => [
				s.name,
				s.port,
				s.running,
				s.compose?.service
			])
		).toEqual([
			["lab-db-1", 5440, true, "db"],
			["mongo", 27018, false, "mongo"]
		]);
		expect(found.servers.map((s) => [s.name, s.running])).toEqual([
			["other-pg", true],
			["old-pg", false]
		]);
	});

	it("conteneur lancé depuis le projet (working_dir) : du projet, même sans compose lu", async () => {
		const app = join(root, "backend");
		const found = await discoverDatabases({
			cwd: root,
			home,
			env: {},
			docker: dockerWith([
				{
					...OLD_PG,
					Name: "/app_postgres",
					Config: {
						...OLD_PG.Config,
						Labels: {
							"com.docker.compose.project": "backend",
							"com.docker.compose.service": "postgres",
							"com.docker.compose.project.working_dir": app
						}
					}
				}
			]),
			portOpen: closed
		});
		expect(found.projectServers.map((s) => s.name)).toContain("app_postgres");
		expect(found.servers).toEqual([]);
	});

	it("base du .env sur le port d'un conteneur arrêté : servie par lui, sauf si le port répond déjà", async () => {
		writeFileSync(
			join(root, ".env"),
			"DATABASE_URL=postgres://u:p@localhost:5450/legacy\n"
		);
		const options = {
			cwd: root,
			home,
			env: {},
			docker: dockerWith([OLD_PG])
		};
		const stopped = await discoverDatabases({ ...options, portOpen: closed });
		expect(stopped.databases[0]?.server).toMatchObject({
			name: "old-pg",
			running: false
		});
		const servedElsewhere = await discoverDatabases({
			...options,
			portOpen: async () => true
		});
		expect(servedElsewhere.databases[0]?.server).toBeUndefined();
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
