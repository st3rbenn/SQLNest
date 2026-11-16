import type { NativeQuery, ResultColumn, ResultSet, Row } from "@sqlnest/snql";
import type { Document } from "mongodb";
import { EngineExecutionError } from "../errors";
import { hydrateBson, normalizeBson } from "./bson";
import type { MongoContext } from "./context";
import {
	type DeclaredTypes,
	declaredTypes,
	textDecimals
} from "./declared-types";
import { describeMongoExecutionError } from "./execution-errors";
import { pipelineWithStoredForms } from "./stored-forms";
import { lookupCollections, withTextDecimalStages } from "./text-decimals";

/**
 * Lectures : pipeline prêt à exécuter, types déclarés d'une collection,
 * commandes brutes, colonnes d'un résultat.
 */

type KeyRenames = readonly {
	readonly path: readonly string[];
	readonly from: string;
	readonly to: string;
}[];

/**
 * Renomme les clés des lignes rendues (ADR-036 E/1f) : `_id` → `id` d'une
 * collection aliasée, à la racine ou dans les documents d'une jointure. La
 * clé garde sa place.
 */
export function renameRowKeys(
	rows: Row[],
	renames: KeyRenames | undefined
): Row[] {
	if (renames === undefined || renames.length === 0) return rows;
	return rows.map(
		(row) =>
			renames.reduce<unknown>(
				(r, x) => renameKeyAt(r, x.path, x.from, x.to),
				row
			) as Row
	);
}

function renameKeyAt(
	value: unknown,
	path: readonly string[],
	from: string,
	to: string
): unknown {
	if (Array.isArray(value))
		return value.map((v) => renameKeyAt(v, path, from, to));
	if (value === null || typeof value !== "object") return value;
	const obj = value as Record<string, unknown>;
	const [head, ...rest] = path;
	if (head !== undefined) {
		return Object.hasOwn(obj, head)
			? { ...obj, [head]: renameKeyAt(obj[head], rest, from, to) }
			: obj;
	}
	if (!Object.hasOwn(obj, from) || Object.hasOwn(obj, to)) return obj;
	return Object.fromEntries(
		Object.entries(obj).map(([k, v]) => [k === from ? to : k, v])
	);
}

/**
 * Colonnes déduites des lignes (union ordonnée des clés) — Mongo n'a pas de
 * schéma fixe. Types + nullable en fallback safe ; l'enrichissement via
 * `inferResultColumns` se fait dans `run.ts` quand un SchemaModel est
 * disponible côté caller.
 */
/**
 * Normalise le résultat d'un db.runCommand() en Row[]. Les commands Mongo
 * retournent des shapes hétérogènes — on inspecte les champs courants qui
 * portent un batch de docs (`cursor.firstBatch` pour aggregate/find, `values`
 * pour distinct, `results` pour explain). Sinon on renvoie le document entier
 * comme une seule row (le user écrit sa command, il sait).
 */
/**
 * Mongo exige `cursor` sur les commandes streamées. Sans lui,
 * `db.command({aggregate: ..., pipeline: [...]})` échoue avec « The 'cursor'
 * option is required, except for aggregate with the explain argument ».
 * Whitelist des commandes concernées — pour les autres (drop, insert, count
 * simple, buildInfo, isMaster…), on n'injecte rien.
 */
function needsCursor(command: Record<string, unknown>): boolean {
	return (
		"aggregate" in command ||
		"find" in command ||
		"listCollections" in command ||
		"listIndexes" in command
	);
}

function extractRowsFromRawResponse(raw: Record<string, unknown>): Row[] {
	const cursor = raw["cursor"];
	if (
		cursor !== null &&
		typeof cursor === "object" &&
		Array.isArray((cursor as { firstBatch?: unknown }).firstBatch)
	) {
		return (cursor as { firstBatch: Row[] }).firstBatch;
	}
	if (Array.isArray(raw["values"]))
		return (raw["values"] as unknown[]).map((v) => ({ value: v }));
	if (Array.isArray(raw["results"])) return raw["results"] as Row[];
	return [raw as Row];
}

export function columnsOf(rows: readonly Row[]): ResultColumn[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!seen.has(key)) {
				seen.add(key);
				names.push(key);
			}
		}
	}
	return names.map((name) => ({
		name,
		type: "unknown" as const,
		nullable: true
	}));
}

/**
 * Pipeline de lecture prêt à exécuter : `decimal` rangés en texte lus comme
 * des nombres (ADR-036 D6), littéraux sous leurs formes stockées, chaîne
 * 24-hex comparée à `_id` redevenue un ObjectId (cf. hydrateBson).
 */
export async function readPipeline(
	cx: MongoContext,
	collection: string,
	stages: readonly Document[]
): Promise<Document[]> {
	const decimals = await textDecimalsOf(cx, [
		collection,
		...lookupCollections(stages)
	]);
	return hydrateBson(
		pipelineWithStoredForms(
			withTextDecimalStages(
				stages,
				decimals.get(collection) ?? [],
				(c) => decimals.get(c) ?? []
			)
		),
		true
	) as Document[];
}

/** `decimal` rangés en texte de chaque collection, en une lecture des validateurs. */
export async function textDecimalsOf(
	cx: MongoContext,
	names: readonly string[]
): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	try {
		const infos = (await cx
			.db()
			.listCollections({ name: { $in: [...new Set(names)] } })
			.toArray()) as {
			readonly name: string;
			readonly options?: { readonly validator?: Document };
		}[];
		for (const info of infos) {
			const fields = textDecimals(declaredTypes(info.options?.validator));
			if (fields.length > 0) out.set(info.name, fields);
		}
	} catch {
		// Validateurs illisibles : la lecture se fait sur les valeurs stockées.
	}
	return out;
}

/** Types déclarés par le validateur de `collection` ; aucun sans validateur. */
export async function loadDeclaredTypes(
	cx: MongoContext,
	collection: string
): Promise<DeclaredTypes> {
	try {
		const info = (
			await cx.db().listCollections({ name: collection }).toArray()
		)[0] as
			| { readonly options?: { readonly validator?: Document } }
			| undefined;
		return declaredTypes(info?.options?.validator);
	} catch {
		return new Map();
	}
}

/**
 * Escape hatch `raw {...}` Mongo → db.runCommand(document). Le résultat
 * est aplati en Row[] : on inspecte les champs classiques d'une réponse
 * Mongo (`cursor.firstBatch`, `results`, `values`) pour extraire des rows ;
 * sinon on renvoie le document brut comme une seule row. Aucun shape
 * stable — c'est l'user qui écrit la command et lit le résultat.
 */
export async function executeRaw(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-raw" }>
): Promise<ResultSet> {
	const db = cx.db();
	try {
		// Mongo exige `cursor: {}` pour toute commande qui streame des
		// résultats (aggregate, find, listCollections, listIndexes…). L'user
		// qui écrit `raw {aggregate: "u", pipeline: [...]}` s'attend à ce
		// que ça marche direct — on inject un cursor vide si absent (safe,
		// override user si présent).
		const command = { ...(query.command as Document) };
		if (needsCursor(command) && !("cursor" in command)) {
			command["cursor"] = {};
		}
		const raw = (await db.command(command)) as Record<string, unknown>;
		const rows = extractRowsFromRawResponse(raw);
		const normalized = rows.map((doc) => normalizeBson(doc) as Row);
		return {
			columns: columnsOf(normalized),
			rows: normalized,
			rowCount: normalized.length
		};
	} catch (cause) {
		throw new EngineExecutionError(
			`raw MongoDB échouée — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}
