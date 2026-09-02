import { describe, expect, it } from "vitest";
import { EngineConfigError } from "../errors";
import { describeMssqlConfig, resolveMssqlConfig } from "./config";

describe("resolveMssqlConfig — URL", () => {
	it("parse une DSN complète avec flags TLS", () => {
		const cfg = resolveMssqlConfig({
			url: "mssql://sa:SqlNest!Dev2022@localhost:1433/Chinook?trustServerCertificate=true"
		});
		expect(cfg).toMatchObject({
			engine: "mssql",
			host: "localhost",
			port: 1433,
			database: "Chinook",
			user: "sa",
			password: "SqlNest!Dev2022",
			encrypt: true,
			trustServerCertificate: true,
			schema: "dbo"
		});
	});

	it("accepte le scheme sqlserver://", () => {
		const cfg = resolveMssqlConfig({
			url: "sqlserver://u:p@db.corp:1433/prod"
		});
		expect(cfg.engine).toBe("mssql");
		expect(cfg.host).toBe("db.corp");
	});

	it("port par défaut 1433, encrypt par défaut true, trust par défaut false", () => {
		const cfg = resolveMssqlConfig({ url: "mssql://u:p@h/db" });
		expect(cfg.port).toBe(1433);
		expect(cfg.encrypt).toBe(true);
		expect(cfg.trustServerCertificate).toBe(false);
	});

	it("`encrypt=false` explicite (passe 2014 / legacy)", () => {
		const cfg = resolveMssqlConfig({ url: "mssql://u:p@h/db?encrypt=false" });
		expect(cfg.encrypt).toBe(false);
	});

	it("refuse une valeur TLS inconnue (pas de fail-open silencieux)", () => {
		expect(() =>
			resolveMssqlConfig({ url: "mssql://u:p@h/db?trustServerCertificate=oui" })
		).toThrow(EngineConfigError);
		expect(() =>
			resolveMssqlConfig({ url: "mssql://u:p@h/db?encrypt=maybe" })
		).toThrow(EngineConfigError);
	});

	it("refuse un scheme étranger", () => {
		expect(() =>
			resolveMssqlConfig({ url: "postgres://u:p@h/db" })
		).toThrow(/mssql/);
	});

	it("refuse une URL sans hôte ou sans database", () => {
		expect(() => resolveMssqlConfig({ url: "mssql://u:p@/db" })).toThrow(
			EngineConfigError
		);
		expect(() => resolveMssqlConfig({ url: "mssql://u:p@h" })).toThrow(
			EngineConfigError
		);
	});

	it("l'erreur d'URL invalide ne contient pas le password", () => {
		try {
			resolveMssqlConfig({ url: "mssql://u:sup3rSecret@h:not-a-port/db" });
			throw new Error("EngineConfigError attendue");
		} catch (e) {
			expect(String(e)).not.toContain("sup3rSecret");
			expect((e as Error).cause).toBeUndefined();
		}
	});
});

describe("resolveMssqlConfig — champs", () => {
	it("applique les défauts", () => {
		const cfg = resolveMssqlConfig({
			host: "h",
			database: "db",
			user: "sa",
			password: "x"
		});
		expect(cfg.port).toBe(1433);
		expect(cfg.encrypt).toBe(true);
		expect(cfg.trustServerCertificate).toBe(false);
		expect(cfg.schema).toBe("dbo");
	});

	it("refuse host/database/user vides", () => {
		expect(() =>
			resolveMssqlConfig({ host: "", database: "db", user: "u" })
		).toThrow(EngineConfigError);
		expect(() =>
			resolveMssqlConfig({ host: "h", database: "", user: "u" })
		).toThrow(EngineConfigError);
		expect(() =>
			resolveMssqlConfig({ host: "h", database: "db", user: "" })
		).toThrow(EngineConfigError);
	});
});

describe("describeMssqlConfig — redaction", () => {
	it("masque le password, annexe les flags non-défaut", () => {
		const cfg = resolveMssqlConfig({
			url: "mssql://sa:secret@h:1433/db?trustServerCertificate=true&encrypt=false"
		});
		const described = describeMssqlConfig(cfg);
		expect(described).toBe(
			"mssql://sa:***@h:1433/db?encrypt=false&trustServerCertificate=true"
		);
		expect(described).not.toContain("secret");
	});

	it("aucun flag annexé quand tout est au défaut", () => {
		const cfg = resolveMssqlConfig({ url: "mssql://sa:x@h/db" });
		expect(describeMssqlConfig(cfg)).toBe("mssql://sa:***@h:1433/db");
	});
});
