import type {
	Collection,
	Field,
	Relation,
	SchemaModel,
	SnqlType
} from "@sqlnest/snql";
import type { Pool as PgPool } from "pg";
import { EngineIntrospectionError } from "../errors";

// --- Lignes brutes renvoyées par le catalogue ---

interface ColumnRow {
	readonly table_name: string;
	readonly column_name: string;
	readonly data_type: string;
	readonly is_nullable: string;
}

interface PkRow {
	readonly table_name: string;
	readonly column_name: string;
}

interface FkRow {
	// Identité STABLE de la contrainte : les noms (conname) ne sont uniques que
	// par table, pas par schéma — grouper par nom fusionnerait des FK homonymes.
	readonly constraint_oid: string;
	readonly from_table: string;
	readonly from_column: string;
	readonly to_table: string;
	readonly to_column: string;
}

// Le schéma cible est un paramètre bindé ($1) — jamais interpolé. Introspection
// et exécution partagent le même schéma (voir `search_path` de l'adapter), donc
// ce que `get <table>` résout est exactement ce qui est introspecté ici.
const TABLES_SQL = `
	SELECT table_name
	FROM information_schema.tables
	WHERE table_schema = $1 AND table_type = 'BASE TABLE'
	ORDER BY table_name`;

const COLUMNS_SQL = `
	SELECT table_name, column_name, data_type, is_nullable
	FROM information_schema.columns
	WHERE table_schema = $1
	ORDER BY table_name, ordinal_position`;

const PK_SQL = `
	SELECT tc.table_name, kcu.column_name
	FROM information_schema.table_constraints tc
	JOIN information_schema.key_column_usage kcu
		ON tc.constraint_name = kcu.constraint_name
		AND tc.table_schema = kcu.table_schema
		AND tc.table_name = kcu.table_name
	WHERE tc.table_schema = $1 AND tc.constraint_type = 'PRIMARY KEY'
	ORDER BY tc.table_name, kcu.ordinal_position`;

// FK via pg_catalog : `unnest ... WITH ORDINALITY` aligne correctement les
// colonnes d'une FK composite (l'information_schema ne préserve pas cet ordre).
// On groupe par OID (identité stable) et on borne LES DEUX côtés au schéma cible
// ($1) : une FK cross-schema donnerait une relation pendante vers une table non
// introspectée (le multi-schéma est une évolution, cf. Questions ouvertes).
const FK_SQL = `
	SELECT
		con.oid::text AS constraint_oid,
		fromtbl.relname AS from_table,
		fromcol.attname AS from_column,
		totbl.relname AS to_table,
		tocol.attname AS to_column
	FROM pg_constraint con
	JOIN pg_class fromtbl ON fromtbl.oid = con.conrelid
	JOIN pg_class totbl ON totbl.oid = con.confrelid
	JOIN pg_namespace fromns ON fromns.oid = fromtbl.relnamespace
	JOIN pg_namespace tons ON tons.oid = totbl.relnamespace
	JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY
		AS cols(from_attnum, to_attnum, ord) ON true
	JOIN pg_attribute fromcol
		ON fromcol.attrelid = con.conrelid AND fromcol.attnum = cols.from_attnum
	JOIN pg_attribute tocol
		ON tocol.attrelid = con.confrelid AND tocol.attnum = cols.to_attnum
	WHERE con.contype = 'f'
		AND fromns.nspname = $1
		AND tons.nspname = $1
	ORDER BY con.oid, cols.ord`;

/** Type Postgres (`information_schema.data_type`) → type unifié SNQL. */
export function mapPgType(dataType: string): SnqlType {
	switch (dataType) {
		case "bigint":
			return "bigint";
		case "integer":
		case "smallint":
			return "int";
		case "boolean":
			return "bool";
		case "numeric":
			return "decimal";
		case "real":
		case "double precision":
			return "float";
		case "text":
		case "character varying":
		case "character":
		case "name":
			return "string";
		case "uuid":
			return "uuid";
		case "json":
		case "jsonb":
			return "json";
		case "ARRAY":
			return "array";
		case "date":
		case "timestamp without time zone":
		case "timestamp with time zone":
		case "time without time zone":
		case "time with time zone":
			return "date";
		default:
			return "unknown";
	}
}

/**
 * Assemble un SchemaModel à partir des lignes du catalogue. **Pur** (testable
 * sans base). Les collections sont limitées aux tables de base ; chaque FK
 * devient une relation `many-to-one` déclarée (confidence 1).
 */
export function buildSchemaModel(
	tables: readonly string[],
	columns: readonly ColumnRow[],
	pks: readonly PkRow[],
	fks: readonly FkRow[]
): SchemaModel {
	const fieldsByTable = new Map<string, Field[]>();
	for (const col of columns) {
		const list = fieldsByTable.get(col.table_name) ?? [];
		list.push({
			name: col.column_name,
			type: mapPgType(col.data_type),
			nullable: col.is_nullable === "YES",
			source: "declared"
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

	return {
		engine: "postgres",
		collections,
		relations: buildRelations(fks)
	};
}

/** Groupe les lignes FK par OID de contrainte (préserve l'ordre des colonnes composites). */
function buildRelations(fks: readonly FkRow[]): Relation[] {
	const byConstraint = new Map<
		string,
		{
			from_table: string;
			to_table: string;
			from: string[];
			to: string[];
		}
	>();
	for (const fk of fks) {
		const entry = byConstraint.get(fk.constraint_oid) ?? {
			from_table: fk.from_table,
			to_table: fk.to_table,
			from: [],
			to: []
		};
		entry.from.push(fk.from_column);
		entry.to.push(fk.to_column);
		byConstraint.set(fk.constraint_oid, entry);
	}

	return [...byConstraint.values()].map((entry) => ({
		from: { collection: entry.from_table, fields: entry.from },
		to: { collection: entry.to_table, fields: entry.to },
		kind: "many-to-one" as const,
		origin: "foreign-key" as const,
		confidence: 1
	}));
}

/**
 * Introspecte une base Postgres et produit le SchemaModel pour le `schema` cible
 * (bindé en $1). Les 4 requêtes catalogue tournent en parallèle via `pool.query`
 * (un client par appel — un même client ne peut pas exécuter de requêtes
 * concurrentes).
 */
export async function introspectPostgres(
	pool: PgPool,
	schema: string
): Promise<SchemaModel> {
	try {
		const params = [schema];
		const [tables, columns, pks, fks] = await Promise.all([
			pool.query<{ table_name: string }>(TABLES_SQL, params),
			pool.query<ColumnRow>(COLUMNS_SQL, params),
			pool.query<PkRow>(PK_SQL, params),
			pool.query<FkRow>(FK_SQL, params)
		]);
		return buildSchemaModel(
			tables.rows.map((row) => row.table_name),
			columns.rows,
			pks.rows,
			fks.rows
		);
	} catch (cause) {
		throw new EngineIntrospectionError("Introspection Postgres échouée", {
			cause
		});
	}
}
