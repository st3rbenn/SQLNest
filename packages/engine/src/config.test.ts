import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { describePostgresConfig, resolvePostgresConfig } from "./config";
import { EngineConfigError } from "./errors";

describe("resolvePostgresConfig — entrée par champs", () => {
	it("applique les valeurs par défaut", () => {
		const cfg = resolvePostgresConfig({
			host: "localhost",
			database: "app",
			user: "sqlnest"
		});
		expect(cfg).toEqual({
			engine: "postgres",
			host: "localhost",
			port: 5432,
			database: "app",
			user: "sqlnest",
			password: "",
			ssl: false,
			poolMax: 10,
			connectionTimeoutMillis: 10_000
		});
	});

	it("respecte les surcharges explicites", () => {
		const cfg = resolvePostgresConfig({
			host: "db.internal",
			port: 6543,
			database: "app",
			user: "u",
			password: "p",
			ssl: true,
			poolMax: 3,
			connectionTimeoutMillis: 2000
		});
		expect(cfg.port).toBe(6543);
		expect(cfg.ssl).toBe(true);
		expect(cfg.poolMax).toBe(3);
		expect(cfg.connectionTimeoutMillis).toBe(2000);
	});

	it("rejette un host/database/user vide", () => {
		expect(() =>
			resolvePostgresConfig({ host: "", database: "app", user: "u" })
		).toThrow(EngineConfigError);
		expect(() =>
			resolvePostgresConfig({ host: "h", database: "", user: "u" })
		).toThrow(EngineConfigError);
		expect(() =>
			resolvePostgresConfig({ host: "h", database: "app", user: "" })
		).toThrow(EngineConfigError);
	});
});

describe("resolvePostgresConfig — entrée par URL", () => {
	it("parse une URL complète", () => {
		const cfg = resolvePostgresConfig({
			url: "postgres://sqlnest:secret@localhost:5555/demo"
		});
		expect(cfg.host).toBe("localhost");
		expect(cfg.port).toBe(5555);
		expect(cfg.database).toBe("demo");
		expect(cfg.user).toBe("sqlnest");
		expect(cfg.password).toBe("secret");
	});

	it("accepte le schéma postgresql:// et un port par défaut", () => {
		const cfg = resolvePostgresConfig({
			url: "postgresql://u@host/db"
		});
		expect(cfg.port).toBe(5432);
		expect(cfg.host).toBe("host");
		expect(cfg.database).toBe("db");
	});

	it("décode les caractères percent-encodés (user/pass/db)", () => {
		const cfg = resolvePostgresConfig({
			url: "postgres://user%40acme:p%40ss%2Fword@host/my%20db"
		});
		expect(cfg.user).toBe("user@acme");
		expect(cfg.password).toBe("p@ss/word");
		expect(cfg.database).toBe("my db");
	});

	it("active ssl selon sslmode", () => {
		expect(
			resolvePostgresConfig({ url: "postgres://u@h/db?sslmode=require" }).ssl
		).toBe(true);
		expect(
			resolvePostgresConfig({ url: "postgres://u@h/db?sslmode=disable" }).ssl
		).toBe(false);
		expect(
			resolvePostgresConfig({ url: "postgres://u@h/db?ssl=true" }).ssl
		).toBe(true);
	});

	it("la surcharge ssl explicite l'emporte sur l'URL", () => {
		const cfg = resolvePostgresConfig({
			url: "postgres://u@h/db?sslmode=require",
			ssl: false
		});
		expect(cfg.ssl).toBe(false);
	});

	it("rejette une URL non-postgres, sans hôte, ou sans base", () => {
		expect(() => resolvePostgresConfig({ url: "mysql://u@h/db" })).toThrow(
			EngineConfigError
		);
		expect(() => resolvePostgresConfig({ url: "not a url" })).toThrow(
			EngineConfigError
		);
		expect(() => resolvePostgresConfig({ url: "postgres://u@host/" })).toThrow(
			EngineConfigError
		);
	});
});

describe("describePostgresConfig", () => {
	it("masque le mot de passe et n'expose jamais le secret", () => {
		const cfg = resolvePostgresConfig({
			url: "postgres://sqlnest:supersecret@localhost:5432/demo"
		});
		const described = describePostgresConfig(cfg);
		expect(described).toBe("postgres://sqlnest:***@localhost:5432/demo");
		expect(described).not.toContain("supersecret");
	});
});

describe("resolvePostgresConfig — sécurité & robustesse", () => {
	it("URL malformée : n'expose PAS le password (ni message, ni cause chaînée)", () => {
		// L'espace rend l'URL invalide → new URL throw. Le password ne doit
		// jamais fuiter, y compris via `error.cause.input` inspecté par un logger.
		let caught: unknown;
		try {
			resolvePostgresConfig({
				url: "postgres://admin:SuperSecret123@bad host/db"
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(EngineConfigError);
		expect((caught as Error).cause).toBeUndefined();
		// Inspection profonde (ce que font console.error / pino / Sentry).
		expect(inspect(caught, { depth: null })).not.toContain("SuperSecret123");
	});

	it("sslmode inconnu (typo) lève plutôt que de désactiver TLS en silence", () => {
		expect(() =>
			resolvePostgresConfig({ url: "postgres://u@h/db?sslmode=required" })
		).toThrow(EngineConfigError);
		// Les valeurs libpq « sans TLS » restent acceptées.
		expect(
			resolvePostgresConfig({ url: "postgres://u@h/db?sslmode=allow" }).ssl
		).toBe(false);
	});

	it("flag ssl : insensible à la casse, lève sur valeur inconnue", () => {
		expect(
			resolvePostgresConfig({ url: "postgres://u@h/db?ssl=TRUE" }).ssl
		).toBe(true);
		expect(() =>
			resolvePostgresConfig({ url: "postgres://u@h/db?ssl=maybe" })
		).toThrow(EngineConfigError);
	});

	it("échappement %XX invalide → EngineConfigError typée (pas un URIError brut)", () => {
		let caught: unknown;
		try {
			resolvePostgresConfig({ url: "postgres://u:ab%@h/db" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(EngineConfigError);
		// Le message ne contient pas la valeur du composant fautif.
		expect((caught as Error).message).not.toContain("ab%");
	});
});
