import { type OperationKind, verbOperation } from "../lexer/dictionary";
import type { Token } from "../lexer/token";
import type { SchemaModel } from "../schema/model";
import type { SnqlCompletion } from "./complete-items";
import { identAfter, type Scope } from "./complete-scope";

/**
 * Complétion dans un document d'insertion et dans un `set` : colonnes
 * restantes, valeurs proposées selon le type.
 */

// --- contexte doc/set schema-aware ------------------------
/**
 * Contexte détecté au curseur pour un doc d'insert ou une set d'update — la
 * table cible + les champs déjà utilisés (pour skip) + la position (clé ou
 * valeur après `:`).
 */
interface DocFieldContext {
	readonly collection: string;
	readonly usedFields: ReadonlySet<string>;
	readonly position: "key" | "value";
	/** Nom de la col dont on tape la valeur (utile pour proposer les enums). */
	readonly currentColumn?: string;
}

/**
 * Détecte si le curseur est dans un doc d'insert ouvert (`add {…}`). Le doc
 * est ouvert si le nombre de `{` dépasse le nombre de `}` dans le préfixe.
 * La target est cherchée dans le préfixe puis dans le suffixe (l'user peut
 * taper le doc AVANT `into <table>` — cas fréquent).
 */
export function insertDocContext(
	prefixToks: readonly Token[],
	suffixToks: readonly Token[]
): DocFieldContext | null {
	if (prefixToks[0]?.kind !== "verb") return null;
	const op = verbOperation(prefixToks[0].value);
	if (op !== "insert") return null;

	// Compte des braces : dans le préfixe, `{` > `}` ⇒ on est dans un doc.
	let depth = 0;
	let lastOpenIdx = -1;
	for (let i = 0; i < prefixToks.length; i += 1) {
		const t = prefixToks[i]!;
		if (t.kind === "lbrace") {
			depth += 1;
			lastOpenIdx = i;
		} else if (t.kind === "rbrace") {
			depth -= 1;
		}
	}
	if (depth <= 0) return null;

	// Target : `into <ident>` dans préfixe OU suffixe.
	let collection = identAfter(prefixToks, "into");
	if (collection === undefined) {
		collection = identAfter(suffixToks, "into");
	}
	if (collection === undefined) return null;

	const usedFields = collectDocKeys(prefixToks, lastOpenIdx);
	const { position, currentColumn } = docCursorPosition(
		prefixToks,
		lastOpenIdx
	);
	return {
		collection,
		usedFields,
		position,
		...(currentColumn !== undefined ? { currentColumn } : {})
	};
}

/**
 * Détecte si le curseur est en position `set` d'un update. `update t set c1
 * = 1, c2 = ...` — après `set`, ou après une virgule qui suit une valeur.
 * Position "value" = après `=`, position "key" = début/après comma.
 */
export function updateSetContext(
	prefixToks: readonly Token[],
	operation: OperationKind | undefined,
	scope: Scope
): DocFieldContext | null {
	if (operation !== "update" || scope.source === undefined) return null;
	let setIdx = -1;
	for (let i = 0; i < prefixToks.length; i += 1) {
		const t = prefixToks[i]!;
		if (t.kind === "keyword" && t.value === "set") setIdx = i;
	}
	if (setIdx === -1) return null;

	// Position clé vs valeur : depuis setIdx, walk et détecter le dernier `=` /
	// `,` / début.
	let position: "key" | "value" = "key";
	let currentColumn: string | undefined;
	const usedFields = new Set<string>();
	// Segments = paires `col = expr` séparés par `,` — on tokenise à la main.
	let segStart = setIdx + 1;
	const flushSegment = (start: number, end: number): void => {
		// Premier ident du segment = col affectée.
		for (let i = start; i < end; i += 1) {
			const t = prefixToks[i]!;
			if (t.kind === "ident") {
				usedFields.add(t.value);
				break;
			}
		}
	};
	for (let i = setIdx + 1; i < prefixToks.length; i += 1) {
		if (prefixToks[i]!.kind === "comma") {
			flushSegment(segStart, i);
			segStart = i + 1;
		}
	}
	// Dernier segment (ouvert) : détermine position + currentColumn.
	const eqIdxInLast = findLastOp(prefixToks, segStart, prefixToks.length, "=");
	if (eqIdxInLast === -1) {
		// Pas de `=` dans le dernier segment ⇒ on tape encore le nom de la col.
		position = "key";
	} else {
		position = "value";
		for (let i = segStart; i < eqIdxInLast; i += 1) {
			const t = prefixToks[i]!;
			if (t.kind === "ident") {
				currentColumn = t.value;
				break;
			}
		}
	}
	return {
		collection: scope.source,
		usedFields,
		position,
		...(currentColumn !== undefined ? { currentColumn } : {})
	};
}

/**
 * Position du curseur dans un doc d'insert `{…}`. Depuis la dernière `{` non
 * fermée, on cherche le dernier segment (post-comma). Un segment sans `:` =
 * on tape la clé ; segment avec `:` = on tape la valeur.
 */
function docCursorPosition(
	toks: readonly Token[],
	lbraceIdx: number
): { position: "key" | "value"; currentColumn?: string } {
	// Trouver le dernier début de segment : `{` ou `,` au niveau top du doc.
	let segStart = lbraceIdx + 1;
	let depth = 0;
	for (let i = lbraceIdx + 1; i < toks.length; i += 1) {
		const t = toks[i]!;
		if (t.kind === "lbrace" || t.kind === "lbracket" || t.kind === "lparen")
			depth += 1;
		else if (
			t.kind === "rbrace" ||
			t.kind === "rbracket" ||
			t.kind === "rparen"
		)
			depth -= 1;
		else if (t.kind === "comma" && depth === 0) segStart = i + 1;
	}
	const colonIdx = findFirstAt(toks, segStart, toks.length, "colon");
	if (colonIdx === -1) return { position: "key" };
	// currentColumn = premier ident du segment (avant `:`).
	let currentColumn: string | undefined;
	for (let i = segStart; i < colonIdx; i += 1) {
		const t = toks[i]!;
		if (t.kind === "ident") {
			currentColumn = t.value;
			break;
		}
	}
	return currentColumn !== undefined
		? { position: "value", currentColumn }
		: { position: "value" };
}

/** Collecte les clés déjà tapées dans le doc courant (dernier `{` ouvert). */
function collectDocKeys(
	toks: readonly Token[],
	lbraceIdx: number
): ReadonlySet<string> {
	const out = new Set<string>();
	let depth = 0;
	let expectingKey = true;
	for (let i = lbraceIdx + 1; i < toks.length; i += 1) {
		const t = toks[i]!;
		if (t.kind === "lbrace" || t.kind === "lbracket" || t.kind === "lparen") {
			depth += 1;
			continue;
		}
		if (t.kind === "rbrace" || t.kind === "rbracket" || t.kind === "rparen") {
			depth -= 1;
			continue;
		}
		if (depth !== 0) continue;
		if (t.kind === "comma") {
			expectingKey = true;
			continue;
		}
		if (t.kind === "colon") {
			expectingKey = false;
			continue;
		}
		if (expectingKey && t.kind === "ident") {
			out.add(t.value);
			expectingKey = false;
		}
	}
	return out;
}

function findFirstAt(
	toks: readonly Token[],
	start: number,
	end: number,
	kind: string
): number {
	for (let i = start; i < end; i += 1) {
		if (toks[i]?.kind === kind) return i;
	}
	return -1;
}

function findLastOp(
	toks: readonly Token[],
	start: number,
	end: number,
	value: string
): number {
	for (let i = end - 1; i >= start; i -= 1) {
		const t = toks[i]!;
		if (t.kind === "op" && t.value === value) return i;
	}
	return -1;
}

/** Suggestions dans un doc d'insert. */
export function docCompletions(
	ctx: DocFieldContext,
	schema: SchemaModel,
	last: Token,
	insideOpenString = false
): readonly SnqlCompletion[] {
	if (ctx.position === "value") {
		return valueSuggestions(ctx, schema, last, insideOpenString);
	}
	// Position clé : garde qu'après `{` ou `,` (sinon on complète pas au milieu
	// d'un ident déjà partiel — laissons le mécanisme prefix-match de CM6 filtrer).
	if (
		last.kind !== "lbrace" &&
		last.kind !== "comma" &&
		last.kind !== "ident"
	) {
		return [];
	}
	return fieldsForDoc(schema, ctx);
}

/** Suggestions dans un `set` d'update. */
export function setCompletions(
	ctx: DocFieldContext,
	schema: SchemaModel,
	last: Token,
	insideOpenString = false
): readonly SnqlCompletion[] {
	if (ctx.position === "value") {
		return valueSuggestions(ctx, schema, last, insideOpenString);
	}
	// Position clé : refuser si le dernier token est un verbe orphelin (ex.
	// `set edit ` — `edit` = alias verb, ne pilote pas la clé). Autorise
	// keyword `set` (juste après `set`), comma (nouvelle affectation), ident
	// (prefix-match en cours).
	if (
		last.kind !== "ident" &&
		last.kind !== "comma" &&
		!(last.kind === "keyword" && last.value === "set")
	) {
		return [];
	}
	return fieldsForDoc(schema, ctx);
}

/**
 * Fields de la target avec detail enrichi (required/optional, FK arrow).
 * Skip les fields déjà utilisés dans le doc pour ne pas les reproposer.
 */
function fieldsForDoc(
	schema: SchemaModel,
	ctx: DocFieldContext
): readonly SnqlCompletion[] {
	const coll = schema.collections.find((c) => c.name === ctx.collection);
	if (coll === undefined) return [];
	return coll.fields
		.filter((f) => !ctx.usedFields.has(f.name))
		.map((f) => ({
			label: f.name,
			type: "field" as const,
			detail: fieldDetailForDoc(f, ctx.collection, schema),
			insertKind: insertKindOf(f.type)
		}));
}

/**
 * classifie un `SnqlType` pour choisir le format d'insertion.
 * string/uuid/enum → wrappé en guillemets, numeric/bool/date/json → nu, autre
 * → raw (`: ` sans quote — laisse l'user finir).
 */
function insertKindOf(
	t: import("../schema/model").SnqlType
): "string" | "number" | "raw" {
	if (t === "string" || t === "uuid" || t === "enum") return "string";
	if (
		t === "int" ||
		t === "bigint" ||
		t === "float" ||
		t === "decimal" ||
		t === "bool" ||
		t === "date" ||
		t === "json"
	) {
		return "number";
	}
	return "raw";
}

/**
 * Detail affiché à droite d'un candidat field dans un doc/set :
 * `<type>` + `· required` si NOT NULL sans default + `→ <target>` si FK.
 */
function fieldDetailForDoc(
	field: import("../schema/model").Field,
	sourceCollection: string,
	schema: SchemaModel
): string {
	const parts: string[] = [field.type];
	if (!field.nullable && field.hasDefault !== true) {
		parts.push("required");
	} else if (field.nullable) {
		parts.push("optional");
	}
	// FK : chercher une relation dont from.collection = sourceCollection et
	// from.fields contient field.name (relation many-to-one classique).
	for (const rel of schema.relations) {
		if (rel.from.collection !== sourceCollection) continue;
		const idx = rel.from.fields.indexOf(field.name);
		if (idx === -1) continue;
		const targetField = rel.to.fields[idx] ?? rel.to.fields[0] ?? "?";
		parts.push(`→ ${rel.to.collection}.${targetField}`);
		break;
	}
	return parts.join(" · ");
}

/**
 * suggestions de valeur pour une col enum.
 * Format inséré = `"<label>"` (guillemets inclus — parité surface SNQL) sauf
 * si l'user a déjà tapé une ouverture de guillemet (cas rare vu qu'on est
 * juste après `:` en général). CM6 gèrera le prefix-match.
 */
function valueSuggestions(
	ctx: DocFieldContext,
	schema: SchemaModel,
	last: Token,
	insideOpenString = false
): readonly SnqlCompletion[] {
	if (ctx.currentColumn === undefined) return [];
	const coll = schema.collections.find((c) => c.name === ctx.collection);
	if (coll === undefined) return [];
	const field = coll.fields.find((f) => f.name === ctx.currentColumn);
	if (field === undefined || field.enumValues === undefined) return [];

	// le smart-apply insère `col: "|"` avec curseur entre les
	// guillemets — insideOpenString détecte ce cas et on insère le label nu
	// (sans re-wrap). `last.kind === "string"` couvre le cas symétrique où
	// l'user a explicitement tapé `col: "foo"` puis revient dedans (le lexer
	// voit une string fermée mais on est peut-être encore avant/à la fin).
	const alreadyQuoted = insideOpenString || last.kind === "string";
	return field.enumValues.map((label) => ({
		label,
		type: "field" as const,
		detail: `enum ${field.name}`,
		...(alreadyQuoted ? {} : { apply: `"${label}"` })
	}));
}
