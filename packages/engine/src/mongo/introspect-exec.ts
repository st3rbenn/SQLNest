import type { NativeQuery, ResultColumn, ResultSet, Row } from "@sqlnest/snql";
import { EngineExecutionError } from "../errors";
import type { MongoContext } from "./context";
import { describeMongoExecutionError } from "./execution-errors";
import { loadRefs } from "./fk";
import {
	applyPkAlias,
	inferCollection,
	loadPkAliases,
	mergeValidatorFields,
	mongoDefaultText,
	type SampledDoc
} from "./introspect";

/**
 * Requêtes d'introspection (`describe`, `list …`) sur MongoDB.
 */

/**
 * Shape stable rendu par `describe <table>`. Identique côté PG (le SQL
 * produit ces mêmes colonnes) → l'UI n'a pas à brancher sur l'engine.
 */
const DESCRIBE_COLUMNS: readonly ResultColumn[] = [
	{ name: "name", type: "string", nullable: false },
	{ name: "type", type: "string", nullable: false },
	{ name: "nullable", type: "bool", nullable: false },
	{ name: "default", type: "string", nullable: true },
	{ name: "is_primary_key", type: "bool", nullable: false },
	{ name: "foreign_key", type: "string", nullable: true }
];

/**
 * Shape stable de `list indexes`. Identique côté PG (le SQL pg_index produit
 * ces mêmes colonnes) → l'UI n'a pas à brancher sur l'engine.
 */
const INDEXES_COLUMNS: readonly ResultColumn[] = [
	{ name: "name", type: "string", nullable: false },
	{ name: "table", type: "string", nullable: false },
	{ name: "unique", type: "bool", nullable: false },
	{ name: "columns", type: "string", nullable: false }
];

/**
 * Dispatch introspection Mongo. `list-tables` → listCollections sur la DB
 * courante, filtre sur les collections user (`type: "collection"`) pour
 * exclure les views/system.
 */
export async function executeIntrospect(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-introspect" }>
): Promise<ResultSet> {
	const db = cx.db();
	try {
		if (query.plan.kind === "list-tables") {
			const infos = await db
				.listCollections({ type: "collection" }, { nameOnly: true })
				.toArray();
			// Les métadonnées `_snql_*` (refs, enums, défauts) ne sont pas des tables.
			const rows: Row[] = infos
				.filter((info) => !info.name.startsWith("_snql_"))
				.map((info) => ({ name: info.name }));
			return {
				columns: [{ name: "name", type: "string", nullable: false }],
				rows,
				rowCount: rows.length
			};
		}
		if (query.plan.kind === "describe-table") {
			const target = query.plan.target;
			if (target === undefined) {
				throw new EngineExecutionError(
					"'describe' sans collection cible (bug parser)"
				);
			}
			// Sample-based : Mongo n'a pas de schéma déclaratif. On réutilise
			// inferCollection (même heuristique que executeIntrospect global)
			// pour rester cohérent — un `describe` doit reporter la même vue
			// des fields que la SchemaModel remontée au CLI.
			const docs = await db
				.collection(target)
				.aggregate([{ $sample: { size: cx.sampleSize } }])
				.toArray();
			const info = (await db.listCollections({ name: target }).toArray())[0] as
				| {
						readonly options?: { readonly validator?: Record<string, unknown> };
				  }
				| undefined;
			const collection = applyPkAlias(
				mergeValidatorFields(
					inferCollection(target, docs as SampledDoc[]),
					info?.options?.validator
				),
				(await loadPkAliases(db)).get(target)
			);
			const { fields } = collection;
			const defaults = new Map<string, string>();
			for (const entry of await db
				.collection("_snql_defaults")
				.find({ collection: target })
				.toArray()) {
				defaults.set(String(entry.column), mongoDefaultText(entry));
			}
			const refs = await loadRefs(cx, "fromCollection", target);
			const rows: Row[] = fields.map((field) => {
				const ref = refs.find((r) => r.fromName === field.name);
				return {
					name: field.name,
					type: field.type,
					nullable: field.nullable,
					default: defaults.get(field.nativeName ?? field.name) ?? null,
					is_primary_key: collection.primaryKey?.includes(field.name) ?? false,
					foreign_key:
						ref !== undefined ? `${ref.toCollection}.${ref.toName}` : null
				};
			});
			return { columns: DESCRIBE_COLUMNS, rows, rowCount: rows.length };
		}
		if (query.plan.kind === "list-schemas") {
			// Mongo n'a pas de "schema" au sens PG — le concept équivalent
			// est la database. admin.listDatabases() nécessite le rôle
			// admin ; certaines connexions n'y ont pas accès. On rebalance
			// avec la DB courante seulement si la commande échoue.
			try {
				const admin = cx.client().db().admin();
				const result = await admin.listDatabases({ nameOnly: true });
				const rows: Row[] = result.databases.map((d) => ({ name: d.name }));
				return {
					columns: [{ name: "name", type: "string", nullable: false }],
					rows,
					rowCount: rows.length
				};
			} catch {
				// Fallback : au moins la DB courante (visible = accessible).
				const rows: Row[] = [{ name: db.databaseName }];
				return {
					columns: [{ name: "name", type: "string", nullable: false }],
					rows,
					rowCount: rows.length
				};
			}
		}
		if (query.plan.kind === "list-databases") {
			// Mongo-first : cluster-wide listing via admin.listDatabases.
			// Nécessite le rôle `clusterMonitor` — les connexions read-only
			// peuvent échouer avec `not authorized`. Pas de fallback silencieux
			// à `[db.databaseName]` : l'user a demandé le cluster, si l'auth
			// refuse c'est une info utile — remonter l'erreur brute.
			const admin = cx.client().db().admin();
			const result = await admin.listDatabases({ nameOnly: true });
			const rows: Row[] = result.databases.map((d) => ({ name: d.name }));
			return {
				columns: [{ name: "name", type: "string", nullable: false }],
				rows,
				rowCount: rows.length
			};
		}
		if (query.plan.kind === "list-enums") {
			// Compensation (sprint EN) : les enums Mongo vivent dans la
			// collection metadata `_snql_enums` ({_id: name, members}).
			// Collection absente → curseur vide = aucun enum, pas d'erreur.
			const docs = await db
				.collection<{ _id: string; members?: readonly string[] }>("_snql_enums")
				.find({})
				.sort({ _id: 1 })
				.toArray();
			const rows: Row[] = docs.map((d) => ({
				name: String(d._id),
				members_count: Array.isArray(d.members) ? d.members.length : 0
			}));
			return {
				columns: [
					{ name: "name", type: "string", nullable: false },
					{ name: "members_count", type: "int", nullable: false }
				],
				rows,
				rowCount: rows.length
			};
		}
		if (query.plan.kind === "describe-enum") {
			const target = query.plan.target;
			if (target === undefined) {
				throw new EngineExecutionError(
					"'describe enum' sans nom cible (bug parser)"
				);
			}
			// Enum inexistant → 0 ligne (parité stricte avec PG où la query
			// catalog rend vide — pas de divergence cross-engine sur un typo).
			const doc = await db
				.collection<{ _id: string; members?: readonly string[] }>("_snql_enums")
				.findOne({ _id: target });
			const members =
				doc !== null && Array.isArray(doc.members) ? doc.members : [];
			const rows: Row[] = members.map((m, i) => ({
				member: m,
				position: i + 1
			}));
			return {
				columns: [
					{ name: "member", type: "string", nullable: false },
					{ name: "position", type: "int", nullable: false }
				],
				rows,
				rowCount: rows.length
			};
		}
		if (query.plan.kind === "list-indexes") {
			const collectionNames =
				query.plan.target !== undefined
					? [query.plan.target]
					: (
							await db
								.listCollections({ type: "collection" }, { nameOnly: true })
								.toArray()
						).map((c) => c.name);
			const rows: Row[] = [];
			for (const name of collectionNames) {
				const idx = await db.collection(name).indexes();
				for (const info of idx) {
					const key = (info as { key: Record<string, unknown> }).key;
					rows.push({
						name: info.name ?? "",
						table: name,
						unique: (info as { unique?: boolean }).unique === true,
						columns: Object.keys(key).join(", ")
					});
				}
			}
			return { columns: INDEXES_COLUMNS, rows, rowCount: rows.length };
		}
		throw new EngineExecutionError(
			`Introspect kind '${query.plan.kind}' non supporté par l'adapter Mongo v1`
		);
	} catch (cause) {
		if (cause instanceof EngineExecutionError) throw cause;
		throw new EngineExecutionError(
			`Introspection MongoDB échouée — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}
