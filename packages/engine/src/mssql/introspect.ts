import type {
	Collection,
	EnumTypeDef,
	Field,
	OnDeleteRule,
	OnUpdateRule,
	ResultSet,
	SchemaModel,
	SnqlType
} from "@sqlnest/snql";
import { EngineIntrospectionError } from "../errors";
import {
	inferNamingRelations,
	relationPairKey
} from "../naming-relations";
import {
	buildIndexesFromRows,
	buildRefsFromFkRows,
	buildRelationsFromFkRows,
	type RelationalFkRow,
	type RelationalIndexRow
} from "../relational-refs";

/**
 * Introspection MSSQL (M/2) → SchemaModel — miroir du pattern PG :
 * tables/colonnes/PK via INFORMATION_SCHEMA, FK via sys.foreign_keys
 * (l'INFORMATION_SCHEMA ne préserve pas l'ordre des colonnes d'une FK
 * composite — `constraint_column_id` si). Pas d'enums : T-SQL n'a pas de
 * type énuméré (compensation metadata en M/6), le SchemaModel sort sans
 * champ `enums`, exactement comme un schéma PG qui n'en déclare aucun.
 */

// --- Lignes brutes renvoyées par le catalogue ---

interface MssqlColumnRow {
	readonly table_name: string;
	readonly column_name: string;
	readonly data_type: string;
	readonly is_nullable: string;
	/** NULL si aucun DEFAULT. Utilisé pour `Field.hasDefault`. */
	readonly column_default: string | null;
}

interface MssqlPkRow {
	readonly table_name: string;
	readonly column_name: string;
}

interface MssqlEnumRow {
	readonly name: string;
	/** JSON array string (`["a","b"]`) — shape écrit par le DDL create-enum. */
	readonly members: string;
}

interface MssqlEnumCheckRow {
	readonly table_name: string;
	readonly definition: string;
}

/** Colonne et valeurs d'un CHECK d'enum ; `undefined` s'il n'en a pas la forme. */
export function parseEnumCheck(
	definition: string
): { readonly column: string; readonly members: string[] } | undefined {
	let column: string | undefined;
	const members: string[] = [];
	for (const m of definition.matchAll(ENUM_CHECK_TERM_RE)) {
		const name = (m[1] as string).replaceAll("]]", "]");
		if (column !== undefined && column !== name) return undefined;
		column = name;
		members.push((m[2] as string).replaceAll("''", "'"));
	}
	return column !== undefined ? { column, members } : undefined;
}

interface MssqlFkRow {
	/** object_id de sys.foreign_keys — identité STABLE (les noms de
	 * contraintes ne sont uniques que par schéma+table parent). */
	readonly constraint_id: string;
	readonly constraint_name: string;
	readonly from_table: string;
	readonly from_column: string;
	readonly to_table: string;
	readonly to_column: string;
	/** delete/update_referential_action : 0=NO ACTION, 1=CASCADE,
	 * 2=SET NULL, 3=SET DEFAULT. */
	readonly on_delete: number;
	readonly on_update: number;
}

// Le schéma cible est un paramètre bindé (@p1) — jamais interpolé. Même
// contrat que PG : ce que l'exécution résout est ce qui est introspecté.
// Les tables metadata SQLNest (préfixe `_snql_`) sont EXCLUES : ce sont des
// compensations internes (enums M/6), jamais des tables user — un node
// `_snql_enums` sur le canvas serait un leak d'implémentation.
const TABLES_SQL = `
	SELECT TABLE_NAME AS table_name
	FROM INFORMATION_SCHEMA.TABLES
	WHERE TABLE_SCHEMA = @p1 AND TABLE_TYPE = 'BASE TABLE'
		AND TABLE_NAME NOT LIKE '\\_snql\\_%' ESCAPE '\\'
	ORDER BY TABLE_NAME`;

// Inclut les colonnes des vues comme côté PG — elles restent orphelines dans
// le grouping (les collections partent de TABLES_SQL) et ne sortent jamais.
const COLUMNS_SQL = `
	SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
		DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable,
		COLUMN_DEFAULT AS column_default
	FROM INFORMATION_SCHEMA.COLUMNS
	WHERE TABLE_SCHEMA = @p1
	ORDER BY TABLE_NAME, ORDINAL_POSITION`;

const PK_SQL = `
	SELECT tc.TABLE_NAME AS table_name, kcu.COLUMN_NAME AS column_name
	FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
	JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
		ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
		AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
		AND tc.TABLE_NAME = kcu.TABLE_NAME
	WHERE tc.TABLE_SCHEMA = @p1 AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
	ORDER BY tc.TABLE_NAME, kcu.ORDINAL_POSITION`;

// Enums compensés (M/6) : table metadata `(name, members JSON array)` écrite
// par le DDL `create enum`. Alimente `schema.enums` — la résolution
// `type: <enum>` au lower create-table ET le node Enums du canvas.
const ENUMS_SQL = `
	SELECT [name], [members]
	FROM [_snql_enums]
	ORDER BY [name]`;

// CHECK `ck_<t>_<c>_enum` des colonnes d'enum : ils portent les valeurs, pas
// le nom de l'enum — la colonne est rattachée à l'enum aux mêmes valeurs.
const ENUM_CHECKS_SQL = `
	SELECT t.name AS table_name, cc.definition AS definition
	FROM sys.check_constraints cc
	JOIN sys.tables t ON t.object_id = cc.parent_object_id
	WHERE SCHEMA_NAME(t.schema_id) = @p1 AND cc.name LIKE N'ck[_]%[_]enum'`;

// T-SQL range `[c] IN (N'a', N'b')` en `([c]=N'a' OR [c]=N'b')`.
const ENUM_CHECK_TERM_RE = /\[((?:[^\]]|\]\])+)\]\s*=\s*N?'((?:[^']|'')*)'/g;

// Index hors clé primaire (contraintes UNIQUE comprises), colonnes de clé dans
// l'ordre ; les colonnes INCLUDE et les tables metadata sont écartées.
const INDEXES_SQL = `
	SELECT t.name AS table_name, i.name AS index_name,
		i.is_unique AS is_unique, c.name AS column_name
	FROM sys.indexes i
	JOIN sys.tables t ON t.object_id = i.object_id
	JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
	JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
	WHERE SCHEMA_NAME(t.schema_id) = @p1 AND i.is_primary_key = 0 AND i.type > 0
		AND ic.is_included_column = 0
		AND t.name NOT LIKE '\\_snql\\_%' ESCAPE '\\'
	ORDER BY t.name, i.name, ic.key_ordinal`;

// Les DEUX côtés bornés au schéma cible (@p1) : une FK cross-schema donnerait
// une relation pendante vers une table non introspectée — même politique que PG.
const FK_SQL = `
	SELECT
		CONVERT(varchar(20), fk.object_id) AS constraint_id,
		fk.name AS constraint_name,
		fk.delete_referential_action AS on_delete,
		fk.update_referential_action AS on_update,
		ft.name AS from_table,
		COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS from_column,
		tt.name AS to_table,
		COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS to_column
	FROM sys.foreign_keys fk
	JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
	JOIN sys.tables ft ON ft.object_id = fk.parent_object_id
	JOIN sys.tables tt ON tt.object_id = fk.referenced_object_id
	WHERE SCHEMA_NAME(ft.schema_id) = @p1 AND SCHEMA_NAME(tt.schema_id) = @p1
	ORDER BY fk.object_id, fkc.constraint_column_id`;

/** Type T-SQL (`INFORMATION_SCHEMA.DATA_TYPE`, lowercase) → type unifié SNQL. */
export function mapMssqlType(dataType: string): SnqlType {
	switch (dataType) {
		case "bigint":
			return "bigint";
		case "int":
		case "smallint":
		case "tinyint":
			return "int";
		case "bit":
			return "bool";
		case "decimal":
		case "numeric":
		case "money":
		case "smallmoney":
			return "decimal";
		case "float":
		case "real":
			return "float";
		case "varchar":
		case "nvarchar":
		case "char":
		case "nchar":
		case "text":
		case "ntext":
		case "xml":
			return "string";
		case "uniqueidentifier":
			return "uuid";
		case "date":
		case "datetime":
		case "datetime2":
		case "smalldatetime":
		case "datetimeoffset":
		case "time":
			return "date";
		default:
			// binary/varbinary/image, rowversion, sql_variant, geography…
			return "unknown";
	}
}

/** referential_action sys.foreign_keys → règle SNQL. 1=CASCADE, 2=SET NULL ;
 * 0 (no action) et 3 (set default) → restrict (défensif, défaut ADR-031 D2 —
 * même repli que les chars pg_constraint côté PG). */
function mssqlRefRule(action: number): OnDeleteRule & OnUpdateRule {
	if (action === 1) return "cascade";
	if (action === 2) return "set-null";
	return "restrict";
}

function normalizeMssqlFkRow(fk: MssqlFkRow): RelationalFkRow {
	return {
		constraintId: fk.constraint_id,
		constraintName: fk.constraint_name,
		fromTable: fk.from_table,
		fromColumn: fk.from_column,
		toTable: fk.to_table,
		toColumn: fk.to_column,
		onDelete: mssqlRefRule(fk.on_delete),
		onUpdate: mssqlRefRule(fk.on_update)
	};
}

/**
 * Assemble le SchemaModel depuis les lignes du catalogue. **Pur** (testable
 * sans base). Chaque FK devient une relation `many-to-one` déclarée
 * (confidence 1) + un RefDef si single-column.
 */
export function buildMssqlSchemaModel(
	tables: readonly string[],
	columns: readonly MssqlColumnRow[],
	pks: readonly MssqlPkRow[],
	fks: readonly MssqlFkRow[],
	enums: readonly MssqlEnumRow[] = [],
	indexRows: readonly RelationalIndexRow[] = [],
	enumChecks: readonly MssqlEnumCheckRow[] = []
): SchemaModel {
	// Enums compensés — members JSON parsés defensivement (une ligne
	// corrompue est ignorée plutôt que de bloquer tout le schéma).
	const enumsList: EnumTypeDef[] = [];
	for (const e of enums) {
		try {
			const members = JSON.parse(e.members) as unknown;
			if (
				Array.isArray(members) &&
				members.every((m) => typeof m === "string")
			) {
				enumsList.push({ name: e.name, members, source: "declared" });
			}
		} catch {
			// ligne metadata corrompue — skip.
		}
	}
	const checkedValues = new Map<string, string[]>();
	for (const row of enumChecks) {
		const parsed = parseEnumCheck(row.definition);
		if (parsed !== undefined) {
			checkedValues.set(
				`${row.table_name}\u0000${parsed.column}`,
				parsed.members
			);
		}
	}

	const fieldsByTable = new Map<string, Field[]>();
	for (const col of columns) {
		const list = fieldsByTable.get(col.table_name) ?? [];
		const hasDefault =
			col.column_default !== null && col.column_default !== undefined;
		const values = checkedValues.get(
			`${col.table_name}\u0000${col.column_name}`
		);
		const enumDef =
			values !== undefined
				? enumsList.find((e) => sameMembers(e.members, values))
				: undefined;
		list.push({
			name: col.column_name,
			type: enumDef !== undefined ? "enum" : mapMssqlType(col.data_type),
			nullable: col.is_nullable === "YES",
			source: "declared",
			...(hasDefault
				? { hasDefault: true as const, defaultExpr: col.column_default as string }
				: {}),
			...(enumDef !== undefined
				? { enumValues: [...enumDef.members], enumTypeName: enumDef.name }
				: values !== undefined
					? { enumValues: values }
					: {})
		});
		fieldsByTable.set(col.table_name, list);
	}

	const pkByTable = new Map<string, string[]>();
	for (const pk of pks) {
		const list = pkByTable.get(pk.table_name) ?? [];
		list.push(pk.column_name);
		pkByTable.set(pk.table_name, list);
	}

	const indexesByTable = buildIndexesFromRows(indexRows);
	const collections: Collection[] = tables.map((name) => {
		const fields = fieldsByTable.get(name) ?? [];
		const primaryKey = pkByTable.get(name);
		const indexes = indexesByTable.get(name);
		return {
			name,
			fields,
			...(primaryKey !== undefined && primaryKey.length > 0
				? { primaryKey }
				: {}),
			...(indexes !== undefined ? { indexes } : {}),
			source: "declared"
		};
	});

	const fkRows = fks.map(normalizeMssqlFkRow);
	const refs = buildRefsFromFkRows(fkRows);
	const declaredRelations = buildRelationsFromFkRows(fkRows);

	// Heuristique de nommage (mécanique partagée Mongo) — vital sur les
	// bases legacy SANS contraintes FK déclarées : les liens n'existent que
	// par convention `<x>_id`. Ne double jamais une FK déclarée ; la clé
	// cible = PK single-column de la table visée, sinon la colonne homonyme
	// (`album.artist_id` → `artist.artist_id`), sinon skip.
	const declaredPairs = new Set(
		declaredRelations.map((r) =>
			relationPairKey(r.from.collection, r.to.collection)
		)
	);
	const inferredRelations = inferNamingRelations(collections, {
		declaredPairs,
		targetKeyFor: (target, sourceFieldName) => {
			if (target.primaryKey?.length === 1) return target.primaryKey[0];
			if (target.fields.some((f) => f.name === sourceFieldName)) {
				return sourceFieldName;
			}
			return undefined;
		}
	});

	return {
		engine: "mssql",
		collections,
		relations: [...declaredRelations, ...inferredRelations],
		...(enumsList.length > 0 ? { enums: enumsList } : {}),
		...(refs.length > 0 ? { refs } : {})
	};
}

/** Exécuteur de requête catalogue — fourni par l'adapter (sa queue `#run`
 * sérialisée) : l'introspection ne connaît ni tedious ni la connexion. */
export type MssqlQueryRunner = (
	text: string,
	params?: readonly unknown[]
) => Promise<ResultSet>;

/**
 * Introspecte la base via le runner et produit le SchemaModel pour le
 * `schema` cible (bindé @p1). TABLES + COLUMNS sont bloquantes (sans, pas de
 * collections utilisables) ; PK / FK sont enrichissantes — soft-fail sur
 * droits manquants pour dégrader (canvas sans PK/edges) plutôt que bloquer,
 * même politique que PG. Les appels partent en parallèle, la queue de
 * l'adapter les sérialise (tedious = 1 request à la fois).
 */
export async function introspectMssql(
	runQuery: MssqlQueryRunner,
	schema: string
): Promise<SchemaModel> {
	const run = retryOnDeadlock(runQuery);
	const params = [schema];
	let tables: ResultSet;
	let columns: ResultSet;
	try {
		[tables, columns] = await Promise.all([
			run(TABLES_SQL, params),
			run(COLUMNS_SQL, params)
		]);
	} catch (cause) {
		throw new EngineIntrospectionError(
			`Introspection MSSQL échouée — ${cause instanceof Error ? cause.message : "cause inconnue"}`,
			{ cause }
		);
	}
	const [pks, fks, enums, indexes, enumChecks] = await Promise.all([
		softQuery(run, PK_SQL, params, "primary keys"),
		softQuery(run, FK_SQL, params, "foreign keys"),
		// Enums compensés (M/6) : la table metadata `_snql_enums` n'existe
		// qu'après le premier `create enum` — 208 (invalid object) est déjà
		// dans les codes soft → 0 enum, jamais un blocage.
		softQuery(run, ENUMS_SQL, params, "enums"),
		softQuery(run, INDEXES_SQL, params, "indexes"),
		softQuery(run, ENUM_CHECKS_SQL, params, "enum checks")
	]);
	return buildMssqlSchemaModel(
		tables.rows.map((row) => String(row["table_name"])),
		columns.rows as unknown as MssqlColumnRow[],
		pks as unknown as MssqlPkRow[],
		fks as unknown as MssqlFkRow[],
		enums as unknown as MssqlEnumRow[],
		indexes as unknown as RelationalIndexRow[],
		enumChecks as unknown as MssqlEnumCheckRow[]
	);
}

const DEADLOCK_VICTIM = 1205;
const DEADLOCK_RETRIES = 3;

/**
 * Lecture du catalogue reprise quand T-SQL la choisit comme victime d'un
 * interblocage (1205, « Rerun the transaction ») — un DDL concurrent, une
 * migration par exemple, verrouille le catalogue. Lecture seule : la
 * reprendre est sans effet de bord.
 */
function retryOnDeadlock(run: MssqlQueryRunner): MssqlQueryRunner {
	return async (sql, params) => {
		for (let attempt = 1; ; attempt += 1) {
			try {
				return await run(sql, params);
			} catch (cause) {
				if (
					attempt >= DEADLOCK_RETRIES ||
					extractMssqlErrorNumber(cause) !== DEADLOCK_VICTIM
				) {
					throw cause;
				}
				await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
			}
		}
	};
}

/**
 * Query enrichissante : renvoie `[]` sur permission manquante (229 SELECT
 * denied, 297 not viewable) ou objet absent (208) — le schéma se construit
 * avec une feature en moins plutôt que de tout bloquer. NB : la metadata
 * visibility MSSQL FILTRE le catalogue plutôt que de refuser — ces numéros
 * sont un filet défensif, pas un chemin courant.
 */
async function softQuery(
	run: MssqlQueryRunner,
	sql: string,
	params: readonly unknown[],
	label: string
): Promise<ResultSet["rows"]> {
	try {
		return (await run(sql, params)).rows;
	} catch (cause) {
		const number = extractMssqlErrorNumber(cause);
		if (number === 229 || number === 297 || number === 208) {
			return [];
		}
		throw new EngineIntrospectionError(
			`Introspection MSSQL (${label}) échouée — ${cause instanceof Error ? cause.message : "cause inconnue"}`,
			{ cause }
		);
	}
}

/** Remonte le `number` du RequestError tedious à travers le wrapping
 * EngineExecutionError du `#run` (cause chain). */
function extractMssqlErrorNumber(cause: unknown): number | undefined {
	let current: unknown = cause;
	for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
		const number = (current as { number?: unknown }).number;
		if (typeof number === "number") return number;
		current = current.cause;
	}
	return undefined;
}

/** Mêmes valeurs ; T-SQL peut les rendre dans un autre ordre. */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((m) => b.includes(m));
}
