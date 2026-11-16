import type { Token } from "../lexer/token";
import type { SchemaModel } from "../schema/model";
import {
	collections,
	fieldsOf,
	keyword,
	type SnqlCompletion
} from "./complete-items";

/**
 * Complétion des requêtes d'introspection (`list …`, `describe …`).
 */

/** Sous-commandes reconnues après `list`. */
export const LIST_SUBCOMMANDS: readonly string[] = [
	"tables",
	"schemas",
	"indexes",
	"databases",
	"schema_events",
	"enums"
];

/**
 * Shape stable de sortie par kind d'introspection. Le complete propose ces
 * cols dans les stages `pick`/`where`/`sort` qui suivent un `describe`/`list`.
 * Aligné positionnellement avec le codegen (postgres.describeTableSql +
 * mongo.adapter DESCRIBE_COLUMNS + listCollections rows + backend
 * `getCanvasChecksumHistory` pour schema_events).
 */
const INTROSPECT_SHAPES: Readonly<Record<string, readonly string[]>> = {
	"list-tables": ["name"],
	"describe-table": [
		"name",
		"type",
		"nullable",
		"default",
		"is_primary_key",
		"foreign_key"
	],
	"list-schemas": ["name"],
	"list-indexes": ["name", "table", "unique", "columns"],
	"list-databases": ["name"],
	"list-schema-events": ["id", "seen_at", "checksum", "db_connection_id"]
};

/** Stages autorisés post-introspection (aligné parseIntrospectTail). */
const INTROSPECT_STAGES: readonly string[] = ["where", "pick", "sort", "limit"];

/** Contexte introspect détecté (kind + optionnellement la table cible). */
interface IntrospectContext {
	readonly kind:
		| "list-tables"
		| "describe-table"
		| "list-schemas"
		| "list-indexes"
		| "list-databases"
		| "list-schema-events";
	readonly shape: readonly string[];
	/** Target présent pour `describe <t>` ou `list indexes on <t>`. */
	readonly target: string | undefined;
}

/**
 * + détecte une commande d'introspection en tête de flux et
 * retourne le shape de sortie + la table cible quand pertinent. Retourne
 * null si non-introspect ou sous-commande inconnue.
 */
export function introspectContextOf(
	toks: readonly Token[]
): IntrospectContext | null {
	const first = toks[0];
	if (first === undefined || first.kind !== "ident") return null;
	const lower = first.value.toLowerCase();
	if (lower === "list") {
		const sub = toks[1];
		if (sub?.kind !== "ident") return null;
		const subLower = sub.value.toLowerCase();
		if (subLower === "tables") {
			return {
				kind: "list-tables",
				shape: INTROSPECT_SHAPES["list-tables"] ?? [],
				target: undefined
			};
		}
		if (subLower === "schemas") {
			return {
				kind: "list-schemas",
				shape: INTROSPECT_SHAPES["list-schemas"] ?? [],
				target: undefined
			};
		}
		if (subLower === "indexes") {
			// `list indexes on <t>` — extrait la table si `on <ident>` est présent.
			// toks[2] = `on` (keyword), toks[3] = <ident>.
			const onKw = toks[2];
			const targetTok = toks[3];
			const target =
				onKw?.kind === "keyword" &&
				onKw.value === "on" &&
				targetTok?.kind === "ident"
					? targetTok.value
					: undefined;
			return {
				kind: "list-indexes",
				shape: INTROSPECT_SHAPES["list-indexes"] ?? [],
				target
			};
		}
		if (subLower === "databases") {
			return {
				kind: "list-databases",
				shape: INTROSPECT_SHAPES["list-databases"] ?? [],
				target: undefined
			};
		}
		if (subLower === "schema_events") {
			return {
				kind: "list-schema-events",
				shape: INTROSPECT_SHAPES["list-schema-events"] ?? [],
				target: undefined
			};
		}
		return null;
	}
	if (lower === "describe") {
		const target = toks[1];
		if (target?.kind === "ident") {
			return {
				kind: "describe-table",
				shape: INTROSPECT_SHAPES["describe-table"] ?? [],
				target: target.value
			};
		}
		return null;
	}
	return null;
}

/**
 * candidats après `for ` — les noms que le shortcut peut cibler.
 *  - describe-table : cols de la table cible (via schema).
 *  - list-tables : noms de collections (la liste des tables).
 */
export function forShortcutTargets(
	context: IntrospectContext,
	schema: SchemaModel
): readonly SnqlCompletion[] {
	if (context.kind === "describe-table" && context.target !== undefined) {
		return fieldsOf(schema, context.target);
	}
	if (context.kind === "list-tables") {
		return collections(schema);
	}
	return [];
}

/**
 * détecte si le dernier token pertinent est un `for` soft-kw dans
 * un contexte introspect — utilisé par le dispatch pour proposer les cibles
 * du shortcut plutôt qu'un stage.
 */
export function lastKeywordIsFor(toks: readonly Token[]): boolean {
	// Scan backward — ignore rien : `for` doit être le dernier ident-kw.
	for (let i = toks.length - 1; i >= 0; i -= 1) {
		const t = toks[i];
		if (t === undefined) continue;
		if (t.kind === "comma") continue; // `for a, |` — traverse la virgule
		if (t.kind === "ident") {
			if (i > 0 && t.value.toLowerCase() === "for") {
				const prev = toks[i - 1];
				// `for` en position 0 = ident de tête (list/describe) — impossible ici.
				if (prev?.kind === "ident" || prev?.kind === "keyword") return true;
			}
			// Un autre ident (nom déjà tapé) → cherche encore en arrière.
			continue;
		}
		return false;
	}
	return false;
}

/** Cols du shape en candidats field (icône property, sans détail). */
export function introspectFields(
	cols: readonly string[]
): readonly SnqlCompletion[] {
	return cols.map((name) => ({ label: name, type: "field" as const }));
}

/** Stages introspect non encore consommés, dans l'ordre canonique. */
export function remainingIntrospectStages(
	toks: readonly Token[]
): readonly SnqlCompletion[] {
	const seen = new Set<string>();
	let sawFor = false;
	let sawOn = false;
	for (const tok of toks) {
		if (tok.kind === "keyword" && INTROSPECT_STAGES.includes(tok.value)) {
			seen.add(tok.value);
		}
		if (tok.kind === "keyword" && tok.value === "on") sawOn = true;
		if (tok.kind === "ident" && tok.value.toLowerCase() === "for") {
			sawFor = true;
		}
	}
	const out: SnqlCompletion[] = [];
	// `on <table>` proposé après `list indexes` (kind spécifique, jamais
	// pertinent après `list tables`/`describe`/etc.). Précède `for` — ordre
	// canonique `list indexes on t for … where … pick … sort … limit`.
	const ctx = introspectContextOf(toks);
	if (ctx?.kind === "list-indexes" && !sawOn && !sawFor && seen.size === 0) {
		out.push({ label: "on", type: "keyword", detail: "table cible" });
	}
	// `for` en tête tant que non déjà consommé, tant qu'aucun stage
	// classique n'a démarré (l'ordre canonique impose for AVANT where/pick/...).
	if (!sawFor && seen.size === 0) {
		out.push({ label: "for", type: "keyword", detail: "filtre rapide" });
	}
	for (const s of INTROSPECT_STAGES) {
		if (!seen.has(s)) out.push(keyword(s));
	}
	return out;
}

/** Stage introspect actif (le dernier keyword INTROSPECT_STAGES vu). */
export function introActiveStage(toks: readonly Token[]): string | undefined {
	for (let i = toks.length - 1; i >= 0; i -= 1) {
		const t = toks[i];
		if (t?.kind === "keyword" && INTROSPECT_STAGES.includes(t.value)) {
			return t.value;
		}
	}
	return undefined;
}
