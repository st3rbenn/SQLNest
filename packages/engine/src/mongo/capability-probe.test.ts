import { SnqlError } from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import {
	assertMongoFeature,
	type MongoFeatures,
	resolveMongoFeatures
} from "./capability-probe";

describe("resolveMongoFeatures (ADR-024 D3)", () => {
	it("Mongo 3.6 standalone : rien n'est supporté sauf topologie", () => {
		const f = resolveMongoFeatures({
			buildInfo: { version: "3.6.23" },
			hello: {}
		});
		expect(f.serverVersion).toBe("3.6.23");
		expect(f.topology).toBe("standalone");
		expect(f.pipelineUpdate).toBe(false);
		expect(f.mergeStandalone).toBe(false);
		expect(f.mergeInTx).toBe(false);
		expect(f.exprConvert).toBe(false);
		expect(f.replicaSet).toBe(false);
	});

	it("Mongo 4.0 standalone : exprConvert OK, pipeline update KO", () => {
		const f = resolveMongoFeatures({
			buildInfo: { version: "4.0.28" },
			hello: {}
		});
		expect(f.exprConvert).toBe(true);
		expect(f.pipelineUpdate).toBe(false);
		expect(f.topology).toBe("standalone");
	});

	it("Mongo 4.2 standalone : pipeline update + $merge stand-alone OK, $merge in tx KO", () => {
		const f = resolveMongoFeatures({
			buildInfo: { version: "4.2.24" },
			hello: {}
		});
		expect(f.pipelineUpdate).toBe(true);
		expect(f.mergeStandalone).toBe(true);
		expect(f.mergeInTx).toBe(false);
		expect(f.replicaSet).toBe(false);
	});

	it("Mongo 4.2 replica set : $merge in tx toujours KO (nécessite 5.0)", () => {
		const f = resolveMongoFeatures({
			buildInfo: { version: "4.2.24" },
			hello: { setName: "rs0" }
		});
		expect(f.replicaSet).toBe(true);
		expect(f.topology).toBe("replicaSet");
		expect(f.mergeStandalone).toBe(true);
		expect(f.mergeInTx).toBe(false);
	});

	it("Mongo 5.0 replica set : tout OK", () => {
		const f = resolveMongoFeatures({
			buildInfo: { version: "5.0.15" },
			hello: { setName: "rs0" }
		});
		expect(f.pipelineUpdate).toBe(true);
		expect(f.mergeStandalone).toBe(true);
		expect(f.mergeInTx).toBe(true);
		expect(f.exprConvert).toBe(true);
		expect(f.replicaSet).toBe(true);
	});

	it("Mongo 5.0 standalone : $merge in tx reste KO (topologie exclue)", () => {
		const f = resolveMongoFeatures({
			buildInfo: { version: "5.0.15" },
			hello: {}
		});
		expect(f.mergeInTx).toBe(false);
		expect(f.topology).toBe("standalone");
	});

	it("Mongo 5.0 sharded : $merge in tx OK", () => {
		const f = resolveMongoFeatures({
			buildInfo: { version: "5.0.15" },
			hello: { msg: "isdbgrid" }
		});
		expect(f.topology).toBe("sharded");
		expect(f.mergeInTx).toBe(true);
		expect(f.replicaSet).toBe(false);
	});

	it("Mongo 7.x replica set : au-delà du plancher, tout OK", () => {
		const f = resolveMongoFeatures({
			buildInfo: { version: "7.0.4" },
			hello: { setName: "rs0" }
		});
		expect(f.pipelineUpdate).toBe(true);
		expect(f.mergeInTx).toBe(true);
	});

	it("version absente ou inconnue : mode dégradé, tout KO", () => {
		const f = resolveMongoFeatures({
			buildInfo: {},
			hello: {}
		});
		expect(f.serverVersion).toBe("unknown");
		expect(f.topology).toBe("unknown");
		expect(f.pipelineUpdate).toBe(false);
	});

	it("version malformée : mode dégradé mais pas throw", () => {
		const f = resolveMongoFeatures({
			buildInfo: { version: "wat" },
			hello: {}
		});
		expect(f.serverVersion).toBe("wat");
		expect(f.pipelineUpdate).toBe(false);
	});
});

describe("assertMongoFeature (ADR-024 D3)", () => {
	const features: MongoFeatures = {
		serverVersion: "4.0.28",
		topology: "standalone",
		pipelineUpdate: false,
		mergeStandalone: false,
		mergeInTx: false,
		exprConvert: true,
		replicaSet: false
	};

	it("passe silencieusement si la feature est disponible", () => {
		expect(() => assertMongoFeature(features, "exprConvert")).not.toThrow();
	});

	it("lève planner_mongo_version_capability_missing sinon", () => {
		try {
			assertMongoFeature(features, "pipelineUpdate");
			expect.fail("expected throw");
		} catch (e) {
			expect(e).toBeInstanceOf(SnqlError);
			expect((e as SnqlError).code).toBe(
				"planner_mongo_version_capability_missing"
			);
			expect((e as SnqlError).message).toContain("pipelineUpdate");
			expect((e as SnqlError).message).toContain("4.0.28");
			expect((e as SnqlError).message).toContain("standalone");
		}
	});
});
