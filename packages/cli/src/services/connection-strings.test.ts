import { describe, expect, it } from "vitest";
import {
	connectionIdentity,
	connectionParts,
	describeConnection,
	parseConnectionString,
	suggestConnectionName,
	withDatabase
} from "./connection-strings";

describe("parseConnectionString — URL", () => {
	it("postgres : hôte, port, base, utilisateur ; URL gardée telle quelle", () => {
		const c = parseConnectionString(
			"postgres://lab:s3cr%40t@localhost:5440/apollon_prisma?schema=public"
		);
		expect(c).toEqual({
			engine: "postgres",
			url: "postgres://lab:s3cr%40t@localhost:5440/apollon_prisma?schema=public",
			host: "localhost",
			port: 5440,
			database: "apollon_prisma",
			user: "lab"
		});
	});

	it("alias postgresql / sqlserver / mongodb+srv, hôtes multiples Mongo", () => {
		expect(
			parseConnectionString("postgresql://u@db.example.com/app")?.engine
		).toBe("postgres");
		expect(
			parseConnectionString("sqlserver://sa:x@localhost:1433/Chinook")
		).toMatchObject({
			engine: "mssql",
			database: "Chinook"
		});
		expect(
			parseConnectionString(
				"mongodb+srv://u:p@cluster0.ab.mongodb.net/shop?retryWrites=true"
			)
		).toMatchObject({
			engine: "mongodb",
			host: "cluster0.ab.mongodb.net",
			port: undefined,
			database: "shop"
		});
		expect(
			parseConnectionString("mongodb://a:27017,b:27018/shop?replicaSet=rs0")
		).toMatchObject({
			host: "a",
			port: 27017,
			database: "shop"
		});
	});

	it("mot de passe avec @ non encodé : l'hôte reste le bon", () => {
		expect(parseConnectionString("postgres://u:p@ss@h:5432/db")).toMatchObject({
			host: "h",
			user: "u",
			database: "db"
		});
	});

	it("guillemets autour de la chaîne (copiée d'un .env) retirés", () => {
		expect(parseConnectionString('"postgres://u:p@h/db"')?.url).toBe(
			"postgres://u:p@h/db"
		);
	});

	it("chaîne non reconnue ou sans hôte → undefined", () => {
		expect(parseConnectionString("mysql://u@h/db")).toBeUndefined();
		expect(parseConnectionString("postgres:///db")).toBeUndefined();
		expect(parseConnectionString("  ")).toBeUndefined();
		expect(parseConnectionString("hello")).toBeUndefined();
	});
});

describe("parseConnectionString — JDBC, ADO.NET, libpq", () => {
	it("JDBC Postgres : user / password de la query passent dans l'URL", () => {
		expect(
			parseConnectionString(
				"jdbc:postgresql://localhost:5433/chinook?user=postgres&password=p%26w&sslmode=disable"
			)
		).toEqual({
			engine: "postgres",
			url: "postgres://postgres:p%26w@localhost:5433/chinook?sslmode=disable",
			host: "localhost",
			port: 5433,
			database: "chinook",
			user: "postgres"
		});
	});

	it("JDBC SQL Server : propriétés, instance ignorée, mot de passe entre accolades", () => {
		expect(
			parseConnectionString(
				"jdbc:sqlserver://localhost\\SQLEXPRESS:1433;databaseName=Chinook;user=sa;password={a;b};encrypt=true;trustServerCertificate=true"
			)
		).toEqual({
			engine: "mssql",
			url: "mssql://sa:a%3Bb@localhost:1433/Chinook?encrypt=true&trustServerCertificate=true",
			host: "localhost",
			port: 1433,
			database: "Chinook",
			user: "sa"
		});
	});

	it("SQL Server au format Prisma (JDBC sans `jdbc:`)", () => {
		expect(
			parseConnectionString(
				"sqlserver://localhost:1433;database=Chinook;user=sa;password=p;trustServerCertificate=true"
			)
		).toEqual({
			engine: "mssql",
			url: "mssql://sa:p@localhost:1433/Chinook?trustServerCertificate=true",
			host: "localhost",
			port: 1433,
			database: "Chinook",
			user: "sa"
		});
	});

	it("ADO.NET : tcp:hôte,port, Initial Catalog, mot de passe entre guillemets", () => {
		expect(
			parseConnectionString(
				'Server=tcp:db.local,14330;Initial Catalog=GEXSUE;User Id=app;Password="p;w""d";TrustServerCertificate=True;'
			)
		).toEqual({
			engine: "mssql",
			url: "mssql://app:p%3Bw%22d@db.local:14330/GEXSUE?trustServerCertificate=true",
			host: "db.local",
			port: 14330,
			database: "GEXSUE",
			user: "app"
		});
		expect(
			parseConnectionString("Data Source=(local);Database=x;Uid=sa;Pwd=y")
		).toMatchObject({
			host: "localhost",
			port: undefined,
			database: "x"
		});
	});

	it("libpq : mots-clés, valeur entre quotes simples", () => {
		expect(
			parseConnectionString(
				"host=localhost port=5436 dbname=apollon-db user=postgres password='a b\\'c' sslmode=require"
			)
		).toEqual({
			engine: "postgres",
			url: "postgres://postgres:a%20b'c@localhost:5436/apollon-db?sslmode=require",
			host: "localhost",
			port: 5436,
			database: "apollon-db",
			user: "postgres"
		});
	});
});

describe("affichage, identité, nom proposé", () => {
	const c = parseConnectionString(
		"postgres://lab:secret@127.0.0.1:5440/Apollon_Prisma"
	);
	if (c === undefined) throw new Error("parse");

	it("describeConnection ne montre jamais le mot de passe", () => {
		expect(describeConnection(c)).toBe("lab@127.0.0.1:5440/Apollon_Prisma");
	});

	it("identité : alias de localhost confondus, port par défaut comblé, base sans casse", () => {
		const same = parseConnectionString(
			"postgresql://other@localhost:5440/apollon_prisma"
		);
		expect(same && connectionIdentity(same)).toBe(connectionIdentity(c));
		const defaultPort = parseConnectionString("mongodb://h/shop");
		expect(defaultPort && connectionIdentity(defaultPort)).toBe(
			"mongodb|h|27017|shop"
		);
	});

	it("nom d'après la base, rendu unique", () => {
		expect(suggestConnectionName(c, [])).toBe("apollon_prisma");
		expect(
			suggestConnectionName(c, ["apollon_prisma", "apollon_prisma-2"])
		).toBe("apollon_prisma-3");
		const noDb = parseConnectionString("mongodb://cluster.example.com");
		expect(noDb && suggestConnectionName(noDb, [])).toBe("cluster-example-com");
	});
});

describe("parties d'une connexion, autre base du serveur", () => {
	const c = parseConnectionString(
		"postgres://lab:s3cr%40t@localhost:5440/apollon_prisma?schema=public"
	);
	if (c === undefined) throw new Error("parse");

	it("connectionParts : secret et base décodés, paramètres gardés", () => {
		expect(connectionParts(c)).toEqual({
			host: "localhost",
			port: 5440,
			database: "apollon_prisma",
			user: "lab",
			password: "s3cr@t",
			params: { schema: "public" }
		});
	});

	it("withDatabase : même serveur, même compte, autre base", () => {
		expect(withDatabase(c, "sqlnest_shadow_x")).toMatchObject({
			engine: "postgres",
			url: "postgres://lab:s3cr%40t@localhost:5440/sqlnest_shadow_x?schema=public",
			database: "sqlnest_shadow_x"
		});
	});
});
