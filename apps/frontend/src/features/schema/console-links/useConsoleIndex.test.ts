import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { consoleTabsKey } from "../../query/useConsoleTabs";
import { useConsoleIndex } from "./useConsoleIndex";

const CONN = "ff958404-df99-47f9-a835-939ccad92b6c";
const TABLES = new Set(["track", "album"]);

function writeTabs(consoleId: string, source: string, name = "Sans titre") {
	localStorage.setItem(
		consoleTabsKey(CONN, consoleId),
		JSON.stringify({
			tabs: [
				{ id: "t1", name, source, lastResult: { rowCount: 3, timingMs: 9 } }
			],
			activeTabId: "t1"
		})
	);
}

describe("useConsoleIndex", () => {
	afterEach(() => {
		localStorage.clear();
	});

	it("rattache une console à la table de départ de sa requête", () => {
		writeTabs(
			"console:a",
			"find track with one album on album_id = album.album_id pick name"
		);
		const { result } = renderHook(() =>
			useConsoleIndex(true, CONN, ["console:a"], TABLES)
		);
		expect(result.current.entries).toEqual([
			{
				id: "console:a",
				tabId: "t1",
				source:
					"find track with one album on album_id = album.album_id pick name",
				title:
					"find track with one album on album_id = album.album_id pick name",
				root: "track",
				joined: ["album"],
				lastResult: { rowCount: 3, timingMs: 9 }
			}
		]);
	});

	it("prend le nom de l'onglet comme titre quand il en a un", () => {
		writeTabs("console:a", "find track pick name", "Pistes");
		const { result } = renderHook(() =>
			useConsoleIndex(true, CONN, ["console:a"], TABLES)
		);
		expect(result.current.entries[0]?.title).toBe("Pistes");
	});

	it("laisse libre une console vide ou hors du schéma", () => {
		writeTabs("console:a", "");
		writeTabs("console:b", "find inconnue pick x");
		writeTabs("console:c", "drop table track");
		const { result } = renderHook(() =>
			useConsoleIndex(
				true,
				CONN,
				["console:a", "console:b", "console:c"],
				TABLES
			)
		);
		expect(result.current.entries).toEqual([]);
	});

	it("ne garde que les tables jointes connues", () => {
		writeTabs(
			"console:a",
			"find track with one fantome on x = fantome.x pick name"
		);
		const { result } = renderHook(() =>
			useConsoleIndex(true, CONN, ["console:a"], TABLES)
		);
		expect(result.current.entries[0]?.joined).toEqual([]);
	});

	it("se relit quand une console écrit ses onglets", () => {
		writeTabs("console:a", "");
		const { result } = renderHook(() =>
			useConsoleIndex(true, CONN, ["console:a"], TABLES)
		);
		expect(result.current.entries).toEqual([]);
		act(() => {
			writeTabs("console:a", "find album pick title");
			window.dispatchEvent(new CustomEvent("mantine-local-storage"));
		});
		expect(result.current.entries[0]?.root).toBe("album");
	});

	it("se dit prêt après la première lecture", () => {
		writeTabs("console:a", "");
		const { result } = renderHook(() =>
			useConsoleIndex(true, CONN, ["console:a"], TABLES)
		);
		expect(result.current.ready).toBe(true);
	});

	it("reste vide quand le prototype est éteint", () => {
		writeTabs("console:a", "find track pick name");
		const { result } = renderHook(() =>
			useConsoleIndex(false, CONN, ["console:a"], TABLES)
		);
		expect(result.current.entries).toEqual([]);
	});
});
