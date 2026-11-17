import type { Edge } from "@sqlnest/canvas";
import { describe, expect, it } from "vitest";
import { DECLARED_EDGE } from "../canvas/relationEdge";
import { litQueryPaths } from "./queryPath";

const edge = (source: string, target: string): Edge => ({
	id: `${source}-${target}`,
	source,
	target,
	style: { stroke: "gris", strokeWidth: 1.5 }
});
const edges = [
	edge("track", "album"),
	edge("album", "artist"),
	edge("invoice", "customer")
];
const tracks = { root: "track", joined: ["album"] };
const invoices = { root: "invoice", joined: ["customer"] };
const styleOf = (lit: Edge[], id: string) =>
	lit.find((e) => e.id === id)?.style;

describe("litQueryPaths", () => {
	it("ne touche à rien sans console dépliée", () => {
		expect(litQueryPaths(edges, [], undefined)).toBe(edges);
	});

	it("ne touche à rien pour des requêtes sans jointure", () => {
		const alone = { root: "track", joined: [] };
		expect(litQueryPaths(edges, [alone], alone)).toBe(edges);
	});

	it("allume le chemin de chaque console dépliée", () => {
		const lit = litQueryPaths(edges, [tracks, invoices], undefined);
		expect(styleOf(lit, "track-album")?.stroke).toBe(DECLARED_EDGE);
		expect(styleOf(lit, "invoice-customer")?.stroke).toBe(DECLARED_EDGE);
		expect(styleOf(lit, "album-artist")?.stroke).toBe("gris");
	});

	it("épaissit le chemin de la requête en cours, pas les autres", () => {
		const lit = litQueryPaths(edges, [tracks, invoices], invoices);
		expect(styleOf(lit, "invoice-customer")?.strokeWidth).toBe(3);
		expect(styleOf(lit, "track-album")?.strokeWidth).toBe(1.5);
		expect(lit.find((e) => e.id === "track-album")?.zIndex).toBe(1);
	});

	it("allume le chemin d'une requête en cours dont la console est repliée", () => {
		const lit = litQueryPaths(edges, [], tracks);
		expect(styleOf(lit, "track-album")).toEqual({
			stroke: DECLARED_EDGE,
			strokeWidth: 3
		});
	});

	it("garde l'épaisseur du chemin en cours quand deux requêtes le partagent", () => {
		const deeper = { root: "track", joined: ["album", "artist"] };
		const lit = litQueryPaths(edges, [tracks, deeper], tracks);
		expect(styleOf(lit, "track-album")?.strokeWidth).toBe(3);
		expect(styleOf(lit, "album-artist")?.strokeWidth).toBe(1.5);
	});
});
