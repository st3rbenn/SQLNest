import { describe, expect, it } from "vitest";
import { queryTables } from "./queryTables";

describe("queryTables", () => {
	it("lit la table de départ d'un find", () => {
		expect(queryTables("find track where track_id < 4 pick name")).toEqual({
			root: "track",
			joined: []
		});
	});

	it("accepte get comme find", () => {
		expect(queryTables("get track pick name").root).toBe("track");
	});

	it("lit les tables jointes dans l'ordre", () => {
		expect(
			queryTables(
				"find track with one album on album_id = album.album_id where track_id < 4 pick name, album.title"
			)
		).toEqual({ root: "track", joined: ["album"] });
	});

	it("rattache une écriture à sa table", () => {
		expect(queryTables('add { id: 1, label: "a" } into t').root).toBe("t");
		expect(
			queryTables("update t where id = 1 set label = upper(label)").root
		).toBe("t");
		expect(queryTables("remove from t where id = 1").root).toBe("t");
	});

	it("garde le rattachement d'une requête incomplète", () => {
		expect(queryTables("find track where").root).toBe("track");
	});

	it("ne rattache ni le vide ni une requête illisible", () => {
		expect(queryTables("")).toEqual({ root: null, joined: [] });
		expect(queryTables('find "').root).toBeNull();
	});
});
