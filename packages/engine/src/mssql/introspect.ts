import type {
	Collection,
	Field,
	OnDeleteRule,
	OnUpdateRule,
	ResultSet,
	SchemaModel,
	SnqlType
} from "@sqlnest/snql";
import { EngineIntrospectionError } from "../errors";
import {
	buildRefsFromFkRows,
	buildRelationsFromFkRows,
	type RelationalFkRow
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
const TABLES_SQL = `
	SELECT TABLE_NAME AS table_name
	FROM INFORMATION_SCHEMA.TABLES
	WHERE TABLE_SCHEMA = @p1 AND TABLE_TYPE = 'BASE TABLE'
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
	fks: readonly MssqlFkRow[]
): SchemaModel {
	const fieldsByTable = new Map<string, Field[]>();
	for (const col of columns) {
		const list = fieldsByTable.get(col.table_name) ?? [];
		const hasDefault =
			col.column_default !== null && col.column_default !== undefined;
		list.push({
			name: col.column_name,
			type: mapMssqlType(col.data_type),
			nullable: col.is_nullable === "YES",
			source: "declared",
			...(hasDefault ? { hasDefault: true as const } : {})
		});
		fieldsByTable.set(col.table_name, list);
	}

	const pkByTable = new Map<string, string[]>();
	for (const pk of pks) {
		const list = pkByTable.get(pk.table_name) ?? [];
		list.push(pk.column_name);
		pkByTable.set(pk.table_name, list);
	}

	const collections: Collection[] = tables.map((name) => {
		const fields = fieldsByTable.get(name) ?? [];
		const primaryKey = pkByTable.get(name);
		return primaryKey !== undefined && primaryKey.length > 0
			? { name, fields, primaryKey, source: "declared" }
			: { name, fields, source: "declared" };
	});

	const fkRows = fks.map(normalizeMssqlFkRow);
	const refs = buildRefsFromFkRows(fkRows);
	return {
		engine: "mssql",
		collections,
		relations: buildRelationsFromFkRows(fkRows),
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
	run: MssqlQueryRunner,
	schema: string
): Promise<SchemaModel> {
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
	const [pks, fks] = await Promise.all([
		softQuery(run, PK_SQL, params, "primary keys"),
		softQuery(run, FK_SQL, params, "foreign keys")
	]);
	return buildMssqlSchemaModel(
		tables.rows.map((row) => String(row["table_name"])),
		columns.rows as unknown as MssqlColumnRow[],
		pks as unknown as MssqlPkRow[],
		fks as unknown as MssqlFkRow[]
	);
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
