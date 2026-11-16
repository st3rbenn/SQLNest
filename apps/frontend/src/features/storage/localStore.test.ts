import { beforeEach, describe, expect, it } from "vitest";
import {
	connectionKey,
	initLocalStore,
	isConnectionId,
	migrateLegacyKeys,
	purgeConnection,
	purgeInvalidConnectionKeys,
	purgeSchemaSlices,
	readJson,
	readText,
	schemaSliceKey,
	storageKeys,
	syncConnectionRegistry,
	writeJson
} from "./localStore";

const A = "ff958404-df99-47f9-a835-939ccad92b6c";
const B = "8517731a-2966-407c-8214-1bace881030d";
const NODE = "console:29f2836d-e5c4-464a-8f3c-064cc265dedb";

const keys = () => Object.keys(window.localStorage).sort();

beforeEach(() => {
	window.localStorage.clear();
});

describe("clés", () => {
	it("reconnaît un identifiant de connexion", () => {
		expect(isConnectionId(A)).toBe(true);
		expect(isConnectionId("ff958404-df99-47f9-")).toBe(false);
		expect(isConnectionId(null)).toBe(false);
	});

	it("clé d'une connexion, avec ou sans suffixe", () => {
		expect(connectionKey("console-nodes", A)).toBe(
			`sqlnest:console-nodes:${A}`
		);
		expect(connectionKey("console-tabs", A, NODE)).toBe(
			`sqlnest:console-tabs:${A}:${NODE}`
		);
		expect(connectionKey("console-tabs", A, "")).toBe(
			`sqlnest:console-tabs:${A}`
		);
	});

	it("un identifiant invalide n'ouvre pas de clé à son nom", () => {
		expect(connectionKey("console-tabs", "ff958404-df99-47f9-", NODE)).toBe(
			"sqlnest:console-tabs:_null"
		);
		expect(connectionKey("schemaEvents:lastSeenAt", null)).toBe(
			"sqlnest:schemaEvents:lastSeenAt:_null"
		);
	});

	it("tranche du canvas par signature du schéma, tables triées", () => {
		expect(
			schemaSliceKey("positions", {
				engine: "postgres",
				collections: [{ name: "track" }, { name: "album" }]
			})
		).toBe("sqlnest:positions:postgres:album,track");
	});
});

describe("accès", () => {
	it("JSON abîmé ou clé absente : undefined", () => {
		window.localStorage.setItem("k", "{oups");
		expect(readJson("k")).toBe(undefined);
		expect(readJson("absente")).toBe(undefined);
	});

	it("écrit puis relit", () => {
		writeJson("k", { a: [1, 2] });
		expect(readJson("k")).toEqual({ a: [1, 2] });
	});
});

describe("anciennes clés", () => {
	it("passent sous leur nom actuel", () => {
		window.localStorage.setItem("sqlnest.gallery.sort", '"name"');
		window.localStorage.setItem("sqlnest.console.results.pageSize", "50");
		window.localStorage.setItem(`sqlnest.console.tabs.${A}`, "tabs-a");
		window.localStorage.setItem(
			`sqlnest.console.tabs.${A}.${NODE}`,
			"tabs-node"
		);
		migrateLegacyKeys();
		expect(keys()).toEqual(
			[
				storageKeys.gallerySort,
				storageKeys.consoleResultsPageSize,
				`sqlnest:console-tabs:${A}`,
				`sqlnest:console-tabs:${A}:${NODE}`
			].sort()
		);
		expect(readText(storageKeys.gallerySort)).toBe('"name"');
		expect(readText(`sqlnest:console-tabs:${A}:${NODE}`)).toBe("tabs-node");
	});

	it("n'écrasent pas une valeur déjà écrite sous le nom actuel", () => {
		window.localStorage.setItem("sqlnest.gallery.view", '"list"');
		window.localStorage.setItem(storageKeys.galleryView, '"grid"');
		migrateLegacyKeys();
		expect(readText(storageKeys.galleryView)).toBe('"grid"');
		expect(keys()).toEqual([storageKeys.galleryView]);
	});

	it("identifiant tronqué : la clé est retirée", () => {
		window.localStorage.setItem(
			"sqlnest.console.tabs.ff958404-df99-47f9-",
			"x"
		);
		migrateLegacyKeys();
		expect(keys()).toEqual([]);
	});
});

describe("ménage", () => {
	it("retire les clés d'un identifiant invalide, garde le reste", () => {
		window.localStorage.setItem(
			"sqlnest:canvas-console:history:ff958404-df99-47f9-",
			"[]"
		);
		window.localStorage.setItem(`sqlnest:canvas-console:history:${A}`, "[]");
		window.localStorage.setItem(storageKeys.canvasConsoleHistory, "[]");
		window.localStorage.setItem("sqlnest:schemaEvents:lastSeenAt:_null", "x");
		window.localStorage.setItem("autre", "x");
		purgeInvalidConnectionKeys();
		expect(keys()).toEqual(
			[
				"autre",
				storageKeys.canvasConsoleHistory,
				`sqlnest:canvas-console:history:${A}`,
				"sqlnest:schemaEvents:lastSeenAt:_null"
			].sort()
		);
	});

	it("purge une connexion : ses clés et sa place dans les récentes", () => {
		window.localStorage.setItem(connectionKey("console-nodes", A), "[]");
		window.localStorage.setItem(connectionKey("console-tabs", A, NODE), "{}");
		window.localStorage.setItem(connectionKey("console-nodes", B), "[]");
		writeJson(storageKeys.recentConnections, [A, B]);
		purgeConnection(A);
		expect(keys()).toEqual(
			[connectionKey("console-nodes", B), storageKeys.recentConnections].sort()
		);
		expect(readJson(storageKeys.recentConnections)).toEqual([B]);
	});

	it("tranches du canvas hors connexion", () => {
		window.localStorage.setItem("sqlnest:positions:postgres:a,b", "{}");
		window.localStorage.setItem("sqlnest:edge-anchors:postgres:a,b", "{}");
		window.localStorage.setItem(connectionKey("console-nodes", A), "[]");
		purgeSchemaSlices();
		expect(keys()).toEqual([connectionKey("console-nodes", A)]);
	});

	it("au démarrage : migration puis identifiants invalides", () => {
		window.localStorage.setItem(`sqlnest.console.tabs.${A}`, "t");
		window.localStorage.setItem("sqlnest:console-nodes:pas-un-id", "[]");
		initLocalStore();
		expect(keys()).toEqual([`sqlnest:console-tabs:${A}`]);
	});
});

describe("connexions disparues", () => {
	it("une connexion vue dans l'équipe puis absente est purgée", () => {
		window.localStorage.setItem(connectionKey("console-nodes", A), "[]");
		window.localStorage.setItem(connectionKey("console-nodes", B), "[]");
		expect(syncConnectionRegistry("equipe", [A, B])).toEqual([]);
		expect(syncConnectionRegistry("equipe", [B])).toEqual([A]);
		expect(readText(connectionKey("console-nodes", A))).toBe(null);
		expect(readText(connectionKey("console-nodes", B))).toBe("[]");
		expect(readJson(storageKeys.connectionRegistry)).toEqual({ [B]: "equipe" });
	});

	it("une connexion jamais vue dans l'équipe est laissée", () => {
		window.localStorage.setItem(connectionKey("console-nodes", A), "[]");
		expect(syncConnectionRegistry("equipe", [B])).toEqual([]);
		expect(readText(connectionKey("console-nodes", A))).toBe("[]");
	});

	it("la liste d'une équipe ne touche pas les connexions d'une autre", () => {
		window.localStorage.setItem(connectionKey("console-nodes", A), "[]");
		syncConnectionRegistry("une", [A]);
		expect(syncConnectionRegistry("autre", [B])).toEqual([]);
		expect(readText(connectionKey("console-nodes", A))).toBe("[]");
		expect(readJson(storageKeys.connectionRegistry)).toEqual({
			[A]: "une",
			[B]: "autre"
		});
	});
});
