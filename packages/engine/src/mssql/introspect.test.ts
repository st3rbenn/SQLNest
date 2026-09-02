import { describe, expect, it } from "vitest";
import { buildMssqlSchemaModel, mapMssqlType } from "./introspect";

describe("mapMssqlType", () => {
	it("mappe les types T-SQL vers les types unifiés SNQL", () => {
		expect(mapMssqlType("bigint")).toBe("bigint");
		expect(mapMssqlType("int")).toBe("int");
		expect(mapMssqlType("smallint")).toBe("int");
		expect(mapMssqlType("tinyint")).toBe("int");
		expect(mapMssqlType("bit")).toBe("bool");
		expect(mapMssqlType("decimal")).toBe("decimal");
		expect(mapMssqlType("numeric")).toBe("decimal");
		expect(mapMssqlType("money")).toBe("decimal");
		expect(mapMssqlType("float")).toBe("float");
		expect(mapMssqlType("real")).toBe("float");
		expect(mapMssqlType("nvarchar")).toBe("string");
		expect(mapMssqlType("varchar")).toBe("string");
		expect(mapMssqlType("nchar")).toBe("string");
		expect(mapMssqlType("ntext")).toBe("string");
		expect(mapMssqlType("xml")).toBe("string");
		expect(mapMssqlType("uniqueidentifier")).toBe("uuid");
		expect(mapMssqlType("datetime")).toBe("date");
		expect(mapMssqlType("datetime2")).toBe("date");
		expect(mapMssqlType("smalldatetime")).toBe("date");
		expect(mapMssqlType("time")).toBe("date");
	});

	it("types binaires / exotiques → unknown", () => {
		expect(mapMssqlType("varbinary")).toBe("unknown");
		expect(mapMssqlType("image")).toBe("unknown");
		expect(mapMssqlType("rowversion")).toBe("unknown");
		expect(mapMssqlType("sql_variant")).toBe("unknown");
		expect(mapMssqlType("geography")).toBe("unknown");
	});
});

describe("buildMssqlSchemaModel", () => {
	const col = (
		table: string,
		name: string,
		type: string,
		nullable = false,
		columnDefault: string | null = null
	) => ({
		table_name: table,
		column_name: name,
		data_type: type,
		is_nullable: nullable ? "YES" : "NO",
		column_default: columnDefault
	});

	it("collections + fields + PK, engine mssql, pas de champ enums", () => {
		const model = buildMssqlSchemaModel(
			["Album", "Artist"],
			[
				col("Album", "AlbumId", "int"),
				col("Album", "Title", "nvarchar"),
				col("Album", "ArtistId", "int"),
				col("Artist", "ArtistId", "int"),
				col("Artist", "Name", "nvarchar", true)
			],
			[
				{ table_name: "Album", column_name: "AlbumId" },
				{ table_name: "Artist", column_name: "ArtistId" }
			],
			[]
		);
		expect(model.engine).toBe("mssql");
		expect(model.enums).toBeUndefined();
		expect(model.collections.map((c) => c.name)).toEqual(["Album", "Artist"]);
		const artist = model.collections[1]!;
		expect(artist.primaryKey).toEqual(["ArtistId"]);
		expect(artist.fields).toEqual([
			{ name: "ArtistId", type: "int", nullable: false, source: "declared" },
			{ name: "Name", type: "string", nullable: true, source: "declared" }
		]);
	});

	it("COLUMN_DEFAULT non-null → hasDefault", () => {
		const model = buildMssqlSchemaModel(
			["T"],
			[col("T", "CreatedAt", "datetime2", false, "(getdate())")],
			[],
			[]
		);
		expect(model.collections[0]!.fields[0]).toMatchObject({
			type: "date",
			hasDefault: true
		});
	});

	it("PK composite : ordre ordinal préservé", () => {
		const model = buildMssqlSchemaModel(
			["PlaylistTrack"],
			[
				col("PlaylistTrack", "PlaylistId", "int"),
				col("PlaylistTrack", "TrackId", "int")
			],
			[
				{ table_name: "PlaylistTrack", column_name: "PlaylistId" },
				{ table_name: "PlaylistTrack", column_name: "TrackId" }
			],
			[]
		);
		expect(model.collections[0]!.primaryKey).toEqual([
			"PlaylistId",
			"TrackId"
		]);
	});

	it("FK single-column → RefDef + relation many-to-one, rules mappées", () => {
		const model = buildMssqlSchemaModel(
			["Album", "Artist"],
			[],
			[],
			[
				{
					constraint_id: "901",
					constraint_name: "FK_AlbumArtistId",
					from_table: "Album",
					from_column: "ArtistId",
					to_table: "Artist",
					to_column: "ArtistId",
					on_delete: 1, // CASCADE
					on_update: 2 // SET NULL
				}
			]
		);
		expect(model.refs).toEqual([
			{
				name: "FK_AlbumArtistId",
				fromCollection: "Album",
				fromColumn: "ArtistId",
				toCollection: "Artist",
				toColumn: "ArtistId",
				onDelete: "cascade",
				onUpdate: "set-null",
				source: "declared"
			}
		]);
		expect(model.relations).toEqual([
			{
				from: { collection: "Album", fields: ["ArtistId"] },
				to: { collection: "Artist", fields: ["ArtistId"] },
				kind: "many-to-one",
				origin: "foreign-key",
				confidence: 1
			}
		]);
	});

	it("actions 0 (no action) et 3 (set default) → restrict défensif", () => {
		const model = buildMssqlSchemaModel(
			["A", "B"],
			[],
			[],
			[
				{
					constraint_id: "1",
					constraint_name: "FK_A_B",
					from_table: "A",
					from_column: "b_id",
					to_table: "B",
					to_column: "id",
					on_delete: 0,
					on_update: 3
				}
			]
		);
		expect(model.refs?.[0]).toMatchObject({
			onDelete: "restrict",
			onUpdate: "restrict"
		});
	});

	it("FK composite : relation multi-colonnes ordonnée, PAS de RefDef", () => {
		const fkRow = (fromCol: string, toCol: string) => ({
			constraint_id: "77",
			constraint_name: "FK_composite",
			from_table: "OrderLine",
			from_column: fromCol,
			to_table: "Order",
			to_column: toCol,
			on_delete: 0,
			on_update: 0
		});
		const model = buildMssqlSchemaModel(
			["Order", "OrderLine"],
			[],
			[],
			[fkRow("order_id", "id"), fkRow("order_version", "version")]
		);
		expect(model.refs).toBeUndefined();
		expect(model.relations).toEqual([
			{
				from: {
					collection: "OrderLine",
					fields: ["order_id", "order_version"]
				},
				to: { collection: "Order", fields: ["id", "version"] },
				kind: "many-to-one",
				origin: "foreign-key",
				confidence: 1
			}
		]);
	});

	it("FK homonymes sur tables différentes : identité par constraint_id, pas par nom", () => {
		const model = buildMssqlSchemaModel(
			["A", "B", "C"],
			[],
			[],
			[
				{
					constraint_id: "10",
					constraint_name: "FK_ref",
					from_table: "A",
					from_column: "c_id",
					to_table: "C",
					to_column: "id",
					on_delete: 0,
					on_update: 0
				},
				{
					constraint_id: "20",
					constraint_name: "FK_ref",
					from_table: "B",
					from_column: "c_id",
					to_table: "C",
					to_column: "id",
					on_delete: 0,
					on_update: 0
				}
			]
		);
		expect(model.refs).toHaveLength(2);
		expect(model.relations).toHaveLength(2);
	});

	it("table sans colonne connue → collection à fields vides (jamais absente)", () => {
		const model = buildMssqlSchemaModel(["Vide"], [], [], []);
		expect(model.collections).toEqual([
			{ name: "Vide", fields: [], source: "declared" }
		]);
	});
});
