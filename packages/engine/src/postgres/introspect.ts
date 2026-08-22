import type {
	Collection,
	Field,
	Relation,
	SchemaModel,
	SnqlType
} from "@sqlnest/snql";
import type { Pool as PgPool, QueryResultRow } from "pg";
import { EngineIntrospectionError } from "../errors";

// --- Lignes brutes renvoyées par le catalogue ---

interface ColumnRow {
	readonly table_name: string;
	readonly column_name: string;
	readonly data_type: string;
	readonly is_nullable: string;
	/** NULL si aucun DEFAULT. Utilisé pour `Field.hasDefault`. */
	readonly column_default: string | null;
	/** Nom du type user-defined pour data_type='USER-DEFINED' (typiquement un
	 *  enum). Lookup dans EnumRow pour peupler `enumValues`. */
	readonly udt_name: string;
}

interface EnumRow {
	readonly typname: string;
	readonly enumlabel: string;
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
	SELECT table_name, column_name, data_type, is_nullable, column_default, udt_name
	FROM information_schema.columns
	WHERE table_schema = $1
	ORDER BY table_name, ordinal_position`;

/**
 * Lit les labels de tous les enums du schéma cible via pg_type + pg_enum.
 * `enumsortorder` préserve l'ordre déclaré (important pour affichage cohérent
 * en autocomplete). typname est le nom du type (matched par ColumnRow.udt_name
 * côté colonnes USER-DEFINED).
 */
const ENUMS_SQL = `
	SELECT t.typname, e.enumlabel
	FROM pg_type t
	JOIN pg_enum e ON e.enumtypid = t.oid
	JOIN pg_namespace ns ON ns.oid = t.typnamespace
	WHERE ns.nspname = $1
	ORDER BY t.typname, e.enumsortorder`;

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
	fks: readonly FkRow[],
	enums: readonly EnumRow[] = []
): SchemaModel {
	const enumLabelsByType = new Map<string, string[]>();
	for (const e of enums) {
		const list = enumLabelsByType.get(e.typname) ?? [];
		list.push(e.enumlabel);
		enumLabelsByType.set(e.typname, list);
	}

	const fieldsByTable = new Map<string, Field[]>();
	for (const col of columns) {
		const list = fieldsByTable.get(col.table_name) ?? [];
		const hasDefault = col.column_default !== null && col.column_default !== undefined;
		// `data_type === "USER-DEFINED"` + udt_name présent dans les enums = type enum.
		// Sinon on retombe sur le mapping data_type standard.
		const enumLabels = col.data_type === "USER-DEFINED"
			? enumLabelsByType.get(col.udt_name)
			: undefined;
		const type = enumLabels !== undefined ? ("enum" as const) : mapPgType(col.data_type);
		list.push({
			name: col.column_name,
			type,
			nullable: col.is_nullable === "YES",
			source: "declared",
			...(hasDefault ? { hasDefault: true as const } : {}),
			...(enumLabels !== undefined ? { enumValues: enumLabels } : {})
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
	const params = [schema];
	// TABLES + COLUMNS sont bloquantes (sans, pas de collections utilisables).
	// PK / FK / ENUMS sont enrichissantes — un rôle read-only strict
	// (RNAcentral, DB SaaS multi-tenant) peut se voir refuser l'accès à
	// pg_enum / pg_constraint (SQLSTATE 42501). Soft-fail chacune pour
	// dégrader gracieusement plutôt que de bloquer tout le canvas.
	let tables, columns;
	try {
		[tables, columns] = await Promise.all([
			pool.query<{ table_name: string }>(TABLES_SQL, params),
			pool.query<ColumnRow>(COLUMNS_SQL, params)
		]);
	} catch (cause) {
		throw new EngineIntrospectionError(
			`Introspection Postgres échouée — ${describePgIntrospectError(cause)}`,
			{ cause }
		);
	}
	const [pks, fks, enums] = await Promise.all([
		softQuery<PkRow>(pool, PK_SQL, params, "primary keys"),
		softQuery<FkRow>(pool, FK_SQL, params, "foreign keys"),
		softQuery<EnumRow>(pool, ENUMS_SQL, params, "enums")
	]);
	return buildSchemaModel(
		tables.rows.map((row) => row.table_name),
		columns.rows,
		pks,
		fks,
		enums
	);
}

/**
 * Query enrichissante : renvoie `[]` sur erreur de droits (42501) ou objet
 * système absent (42P01) — laisse le schéma se construire avec un feature
 * en moins plutôt que de tout bloquer. Les autres erreurs restent propagées.
 */
async function softQuery<T extends QueryResultRow>(
	pool: PgPool,
	sql: string,
	params: unknown[],
	label: string
): Promise<T[]> {
	try {
		const result = await pool.query<T>(sql, params);
		return result.rows;
	} catch (cause) {
		const code = cause instanceof Error
			? (cause as { code?: unknown }).code
			: undefined;
		if (code === "42501" || code === "42P01") {
			// Droit manquant ou catalog inaccessible — dégradation silencieuse.
			// La feature qui dépend de `label` (autocomplete enum, inférence
			// multiplicité join…) sera absente mais rien ne casse.
			return [];
		}
		throw new EngineIntrospectionError(
			`Introspection Postgres (${label}) échouée — ${describePgIntrospectError(cause)}`,
			{ cause }
		);
	}
}

function describePgIntrospectError(cause: unknown): string {
	if (cause instanceof Error) {
		const code = (cause as { code?: unknown }).code;
		return typeof code === "string" && code.length > 0
			? `${cause.message} (SQLSTATE ${code})`
			: cause.message;
	}
	return "cause inconnue";
}
