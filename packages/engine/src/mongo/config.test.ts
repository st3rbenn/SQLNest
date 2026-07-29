import { describe, expect, it } from "vitest";
import { EngineConfigError } from "../errors";
import { describeMongoConfig, resolveMongoConfig } from "./config";

describe("resolveMongoConfig", () => {
	it("déduit la base du chemin de l'URL", () => {
		const cfg = resolveMongoConfig({
			url: "mongodb://u:p@host:27017/mydb?authSource=admin"
		});
		expect(cfg.engine).toBe("mongodb");
		expect(cfg.database).toBe("mydb");
		expect(cfg.sampleSize).toBe(100);
	});

	it("le champ database explicite l'emporte sur l'URL", () => {
		expect(
			resolveMongoConfig({ url: "mongodb://host/a", database: "b" }).database
		).toBe("b");
	});

	it("accepte le schéma mongodb+srv", () => {
		expect(resolveMongoConfig({ url: "mongodb+srv://host/db" }).database).toBe(
			"db"
		);
	});

	it("rejette une URL non-mongo, sans base, ou malformée", () => {
		expect(() => resolveMongoConfig({ url: "postgres://h/db" })).toThrow(
			EngineConfigError
		);
		expect(() => resolveMongoConfig({ url: "mongodb://host" })).toThrow(
			EngineConfigError
		);
		expect(() => resolveMongoConfig({ url: "pas une url" })).toThrow(
			EngineConfigError
		);
	});

	it("rejette un sampleSize non entier positif", () => {
		expect(() =>
			resolveMongoConfig({ url: "mongodb://h/db", sampleSize: 0 })
		).toThrow(EngineConfigError);
	});

	it("accepte une URI multi-hôtes (replica set self-hosted)", () => {
		const cfg = resolveMongoConfig({
			url: "mongodb://u:p@h1:27017,h2:27017,h3:27017/rsdb?replicaSet=rs0"
		});
		expect(cfg.database).toBe("rsdb");
	});
});

describe("describeMongoConfig", () => {
	it("masque l'userinfo de l'URI (aucun secret)", () => {
		const cfg = resolveMongoConfig({
			url: "mongodb://sqlnest:supersecret@host:27017/demo"
		});
		const described = describeMongoConfig(cfg);
		expect(described).not.toContain("supersecret");
		expect(described).toBe("mongodb://***@host:27017/demo");
	});

	it("retire la query — un secret en query-param ne fuit pas", () => {
		const cfg = resolveMongoConfig({
			url: "mongodb://user:pw@host/db?tlsCertificateKeyFilePassword=SECRET&authSource=admin"
		});
		const described = describeMongoConfig(cfg);
		expect(described).not.toContain("SECRET");
		expect(described).not.toContain("pw");
		expect(described).toBe("mongodb://***@host/db");
	});
});
