import { describe, expect, it, vi } from "vitest";
import {
	type DockerRunner,
	discoverContainers,
	startDockerServer
} from "./docker";
import { serverConnection } from "./servers";
import type { DiscoveredServer } from "./types";

const PS = [
	{
		ID: "a1",
		Image: "postgres:16-alpine",
		Ports: "0.0.0.0:5440->5432/tcp, [::]:5440->5432/tcp"
	},
	{ ID: "b2", Image: "mongo:7", Ports: "0.0.0.0:27017->27017/tcp" },
	{
		ID: "c3",
		Image: "mcr.microsoft.com/mssql/server:2022-latest",
		Ports: "127.0.0.1:1433->1433/tcp"
	},
	{ ID: "d4", Image: "redis:7-alpine", Ports: "0.0.0.0:6379->6379/tcp" },
	{ ID: "e5", Image: "sqlnest-orm-lab-prisma", Ports: "" },
	{
		ID: "f6",
		Image: "registry.local/team/db:3",
		Ports: "0.0.0.0:5499->5432/tcp"
	},
	// Arrêté : plus aucun port dans `ps`.
	{ ID: "g7", Image: "postgres:16-alpine", Ports: "" }
];

const RUNNING = { Running: true };

const INSPECT = [
	{
		Name: "/orm-lab-postgres",
		State: RUNNING,
		Config: {
			Image: "postgres:16-alpine",
			Env: [
				"POSTGRES_USER=lab",
				"POSTGRES_PASSWORD=l=b",
				"POSTGRES_DB=lab",
				"PATH=/usr/bin"
			],
			Labels: {
				"com.docker.compose.project": "sqlnest-orm-lab",
				"com.docker.compose.service": "db"
			}
		},
		NetworkSettings: {
			Ports: {
				"5432/tcp": [
					{ HostIp: "0.0.0.0", HostPort: "5440" },
					{ HostIp: "::", HostPort: "5440" }
				]
			}
		}
	},
	{
		Name: "/sqlnest-mongo",
		State: RUNNING,
		Config: {
			Image: "mongo:7",
			Env: ["MONGO_INITDB_DATABASE=sqlnest_demo"],
			Labels: {}
		},
		NetworkSettings: {
			Ports: { "27017/tcp": [{ HostIp: "0.0.0.0", HostPort: "27017" }] }
		}
	},
	{
		Name: "/sqlnest-mssql",
		State: RUNNING,
		Config: {
			Image: "mcr.microsoft.com/mssql/server:2022-latest",
			Env: ["ACCEPT_EULA=Y", "MSSQL_SA_PASSWORD=Str0ng!"],
			Labels: null
		},
		NetworkSettings: {
			Ports: { "1433/tcp": [{ HostIp: "127.0.0.1", HostPort: "1433" }] }
		}
	},
	{
		Name: "/team-db",
		State: RUNNING,
		Config: { Image: "registry.local/team/db:3", Env: [] },
		NetworkSettings: {
			Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5499" }] }
		}
	},
	{
		Name: "/shop_postgres",
		State: { Running: false },
		Config: {
			Image: "postgres:16-alpine",
			Env: ["POSTGRES_USER=postgres", "POSTGRES_DB=shop-db"],
			Labels: {
				"com.docker.compose.project": "backend",
				"com.docker.compose.service": "postgres",
				"com.docker.compose.project.working_dir": "/srv/shop/backend"
			}
		},
		HostConfig: {
			PortBindings: { "5432/tcp": [{ HostIp: "", HostPort: "5436" }] }
		},
		NetworkSettings: { Ports: {} }
	}
];

function runner(): DockerRunner {
	return vi.fn(async (args: readonly string[]) => {
		if (args[0] === "ps") return PS.map((l) => JSON.stringify(l)).join("\n");
		if (args[0] === "inspect") return JSON.stringify(INSPECT);
		return undefined;
	});
}

describe("discoverContainers", () => {
	it("tous les conteneurs (`ps -a`) ; n'inspecte que ceux de bases", async () => {
		const docker = runner();
		await discoverContainers(docker);
		expect(docker).toHaveBeenCalledWith(["ps", "-a", "--format", "{{json .}}"]);
		expect(docker).toHaveBeenCalledWith([
			"inspect",
			"a1",
			"b2",
			"c3",
			"f6",
			"g7"
		]);
	});

	it("moteur, port publié, identifiants de l'environnement", async () => {
		const servers = await discoverContainers(runner());
		expect(servers.slice(0, 4)).toEqual([
			{
				engine: "postgres",
				name: "orm-lab-postgres",
				image: "postgres:16-alpine",
				host: "localhost",
				port: 5440,
				user: "lab",
				password: "l=b",
				passwordless: false,
				maintenanceDatabase: "lab",
				defaultDatabase: "lab",
				params: {},
				running: true,
				container: "orm-lab-postgres",
				compose: { project: "sqlnest-orm-lab", service: "db" }
			},
			{
				engine: "mongodb",
				name: "sqlnest-mongo",
				image: "mongo:7",
				host: "localhost",
				port: 27017,
				user: undefined,
				password: undefined,
				passwordless: true,
				maintenanceDatabase: "admin",
				defaultDatabase: "sqlnest_demo",
				params: { directConnection: "true" },
				running: true,
				container: "sqlnest-mongo"
			},
			expect.objectContaining({
				engine: "mssql",
				name: "sqlnest-mssql",
				user: "sa",
				password: "Str0ng!",
				maintenanceDatabase: "master",
				params: { trustServerCertificate: "true" }
			}),
			// Image inconnue, port 5432 exposé : Postgres, identifiants par défaut.
			expect.objectContaining({
				engine: "postgres",
				name: "team-db",
				port: 5499,
				user: "postgres",
				password: undefined,
				passwordless: false,
				defaultDatabase: "postgres"
			})
		]);
	});

	it("conteneur arrêté : port de sa config, dossier du projet compose", async () => {
		const servers = await discoverContainers(runner());
		expect(servers[4]).toMatchObject({
			name: "shop_postgres",
			host: "localhost",
			port: 5436,
			running: false,
			container: "shop_postgres",
			defaultDatabase: "shop-db",
			compose: {
				project: "backend",
				service: "postgres",
				dir: "/srv/shop/backend"
			}
		});
	});

	it("URL d'une base du serveur : secret encodé, paramètres du moteur", async () => {
		const [pg, mongo, mssql] = await discoverContainers(runner());
		expect(pg && serverConnection(pg, "apollon_prisma").url).toBe(
			"postgres://lab:l%3Db@localhost:5440/apollon_prisma"
		);
		expect(mongo && serverConnection(mongo, "sqlnest_demo").url).toBe(
			"mongodb://localhost:27017/sqlnest_demo?directConnection=true"
		);
		expect(mssql && serverConnection(mssql, "Chinook").url).toBe(
			"mssql://sa:Str0ng!@localhost:1433/Chinook?trustServerCertificate=true"
		);
	});

	it("Docker absent ou arrêté → aucun serveur", async () => {
		expect(await discoverContainers(async () => undefined)).toEqual([]);
		expect(await discoverContainers(async () => "")).toEqual([]);
	});
});

describe("startDockerServer", () => {
	const server: DiscoveredServer = {
		engine: "postgres",
		name: "shop_postgres",
		image: "postgres:16-alpine",
		host: "localhost",
		port: 5436,
		user: "postgres",
		password: undefined,
		passwordless: false,
		maintenanceDatabase: "shop-db",
		defaultDatabase: "shop-db",
		params: {},
		running: false
	};

	it("conteneur existant : `docker start`, ses ports d'origine gardés", async () => {
		const run = vi.fn(async () => "");
		await startDockerServer({ ...server, container: "shop_postgres" }, run);
		expect(run).toHaveBeenCalledWith(
			["start", "shop_postgres"],
			undefined,
			60_000
		);
	});

	it("service compose jamais créé : `docker compose up -d` dans son dossier", async () => {
		const run = vi.fn(async () => "");
		await startDockerServer(
			{
				...server,
				compose: {
					project: "backend",
					service: "postgres",
					dir: "/srv/shop/backend"
				}
			},
			run
		);
		expect(run).toHaveBeenCalledWith(
			["compose", "up", "-d", "postgres"],
			"/srv/shop/backend",
			60_000
		);
	});

	it("échec de Docker : l'erreur remonte", async () => {
		const run = vi.fn(async () => {
			throw new Error(
				"Bind for 0.0.0.0:5436 failed: port is already allocated"
			);
		});
		await expect(
			startDockerServer({ ...server, container: "shop_postgres" }, run)
		).rejects.toThrow("port is already allocated");
	});
});
