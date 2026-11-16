import type { Token } from "../lexer/token";
import { DDL_DEFAULT_FUNCTIONS } from "../parser/parser";
import type { SchemaModel } from "../schema/model";
import {
	collections,
	ddlTypeSuggestions,
	enumSuggestions,
	keyword,
	refSuggestions,
	refTargetColumns,
	type SnqlCompletion
} from "./complete-items";
import { defined } from "../invariant";

/**
 * Complétion du DDL : tables, colonnes, index, clés étrangères, enums.
 */

/** Modifiers de field (create table body + add column) — ADR-029 D0. */
const DDL_FIELD_MODIFIERS: readonly string[] = [
	"nullable",
	"not",
	"default",
	"unique"
];

/**
 * ADR-029 DDL/5 — Complétions contextuelles pour tous les DDL kinds. Détecte
 * le kind depuis les premiers tokens (create table / add column / add index /
 * drop table/column/index) et propose la suggestion appropriée selon la
 * position dans le pattern.
 *
 * Retourne `null` si le statement n'est pas un DDL — dispatch fallthrough
 * vers le pipeline DML classique.
 */
export function ddlContextOptions(
	toks: readonly Token[],
	schema: SchemaModel,
	suffixToks: readonly Token[] = []
): readonly SnqlCompletion[] | null {
	if (toks.length === 0) return null;
	const head = toks[0];
	if (head === undefined) return null;
	const headLower = head.value.toLowerCase();

	// === create table === (parseCreateTable dispatch = verb create + keyword table)
	if (head.kind === "verb" && headLower === "create" && toks.length >= 2) {
		const t1 = toks[1];
		if (t1 === undefined || t1.value.toLowerCase() !== "table") return null;
		return createTableCompletions(toks, schema);
	}

	// === add column / add index / add unique index / add enum member ===
	// (verb add + soft-ident) — Enum/3 étend ce dispatch.
	if (head.kind === "verb" && headLower === "add" && toks.length >= 2) {
		const t1 = toks[1];
		if (t1 === undefined) return null;
		const t1Lower = t1.value.toLowerCase();
		if (t1Lower === "column") return addColumnCompletions(toks, schema);
		if (t1Lower === "index" || t1Lower === "unique") {
			// `add unique ` (2 toks) OU `add unique index …` (3+ toks) : dispatch
			// addIndexCompletions dans les 2 cas. Sur 2 toks il propose `index`.
			return addIndexCompletions(toks, schema);
		}
		if (t1Lower === "enum") return addEnumMemberCompletions(toks, schema);
		if (t1Lower === "ref") return addRefCompletions(toks, schema, suffixToks);
		return null;
	}

	// === alter column <t>.<c> set … === (ADR-036 E/1c)
	if (head.kind === "ident" && headLower === "alter" && toks.length >= 2) {
		if (toks[1]?.value.toLowerCase() !== "column") return null;
		return alterColumnCompletions(toks, schema);
	}

	// === rename column <t>.<c> to <n> === (ADR-036 E/1b)
	if (head.kind === "ident" && headLower === "rename" && toks.length >= 2) {
		if (toks[1]?.value.toLowerCase() !== "column") return null;
		return renameColumnCompletions(toks, schema);
	}

	// === drop table / drop column / drop index / drop enum ===
	// (soft-ident drop head) — Enum/3 étend ce dispatch.
	if (head.kind === "ident" && headLower === "drop" && toks.length >= 2) {
		const t1 = toks[1];
		if (t1 === undefined) return null;
		const t1Lower = t1.value.toLowerCase();
		if (t1Lower === "table") return dropTableCompletions(toks, schema);
		if (t1Lower === "column") return dropColumnCompletions(toks, schema);
		if (t1Lower === "index") return dropIndexCompletions(toks, schema);
		if (t1Lower === "enum") return dropEnumCompletions(toks, schema);
		if (t1Lower === "ref") return dropRefCompletions(toks, schema);
		return null;
	}

	return null;
}

/** Complétions pour `create table X { … }` (DDL/1). */
function createTableCompletions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] {
	const last = toks[toks.length - 1];
	if (last === undefined) return [];

	// `create table |` → nom de nouvelle table (libre, pas de collections car
	// on la crée !) — pas de suggestion précise possible.
	if (toks.length === 2) return [];

	// `create table X |` → soit `{` (body), soit `if not exists`.
	if (toks.length === 3 && last.kind === "ident") {
		return [keyword("if"), { label: "{", type: "keyword" }];
	}

	// Dans le body : détection contextuelle basée sur les 2 derniers tokens.
	const inBody = toks.some((t) => t.kind === "lbrace");
	if (!inBody) return [];

	// PK-fields d'abord : `primary key (|` et `primary key (a, |` ont un
	// `comma`/`lparen` en tail qui match aussi le case start-of-field plus bas
	// — sans ce court-circuit, `primary` gagnerait.
	if (
		(last.kind === "lparen" || last.kind === "comma") &&
		isInsidePrimaryKeyParens(toks)
	) {
		return primaryKeyFieldSuggestions(toks);
	}

	// `{ |` ou `, |` = début d'un nouveau field. Nom libre, on propose juste
	// le seul keyword structurel valide ici (D0 ADR-029).
	if (last.kind === "lbrace" || last.kind === "comma") {
		return [keyword("primary")];
	}

	// `{ col :` → types SNQL + aliases (D6) + enums en scope (ADR-030 Enum/2b).
	if (last.kind === "colon") return ddlTypeSuggestions(schema);

	// Modifier `ref t.c [on delete ...]` (ADR-031 FK/1). Détecté tôt car les
	// tails (`ref`, `X.`, `on delete`) recoupent le case modifier générique.
	const refCtx = refClauseCompletions(toks, schema);
	if (refCtx !== null) return refCtx;

	// `{ col: uuid |` OU `{ col: uuid nullable |` → modifiers + `,` + `primary`.
	// Détection : dernier token = ident de type, ou modifier connu.
	if (last.kind === "ident") {
		const prev = toks[toks.length - 2];
		if (prev !== undefined && prev.kind === "colon") {
			// On vient de taper le type — propose modifiers.
			return [...DDL_FIELD_MODIFIERS.map(keyword), keyword("ref")];
		}
		if (
			DDL_FIELD_MODIFIERS.includes(last.value.toLowerCase()) ||
			last.value.toLowerCase() === "null" ||
			last.value.toLowerCase() === "unique"
		) {
			// Après un modifier → autres modifiers restants + ref.
			return [...DDL_FIELD_MODIFIERS.map(keyword), keyword("ref")];
		}
	}

	// `primary |` → `key` (primary est kind:"keyword" via KEYWORDS lexer DDL/1).
	if (last.kind === "keyword" && last.value === "primary") {
		return [keyword("key")];
	}

	// `primary key |` → `(` (parens obligatoires). `key` reste soft-ident.
	if (last.kind === "ident" && last.value.toLowerCase() === "key") {
		return [{ label: "(", type: "keyword" }];
	}

	return [];
}

/**
 * Complétions dans un modifier `ref <target>.<col> [on delete/update <rule>]
 * [as <name>]` (ADR-031 FK/1). Retourne `null` si le tail n'est pas dans une
 * clause ref (dispatch fallthrough vers les modifiers génériques). Détection
 * purement par tail de tokens :
 *  - `ref |`               → collections cibles
 *  - `ref X.|`             → colonnes de X (PK/unique d'abord serait idéal ;
 *                            V1 = toutes les colonnes)
 *  - `ref X.y |`           → `on` / `as`
 *  - `on |` (en clause ref)→ `delete` / `update`
 *  - `on delete |`         → `cascade` / `restrict` / `set null`
 */
function refClauseCompletions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] | null {
	const n = toks.length;
	const last = toks[n - 1];
	if (last === undefined) return null;
	const at = (i: number): Token | undefined => toks[i];
	const isRef = (t: Token | undefined): boolean =>
		t !== undefined && t.kind === "ident" && t.value.toLowerCase() === "ref";

	// `ref |` → collections cibles.
	if (isRef(last)) return collections(schema);

	// `ref X.|` → colonnes de X.
	if (last.kind === "dot" && at(n - 2)?.kind === "ident" && isRef(at(n - 3))) {
		const targetColl = defined(at(n - 2)).value;
		return refTargetColumns(schema, targetColl);
	}

	// `ref X.y |` (ident après `X.`) → `on` / `as`.
	if (
		last.kind === "ident" &&
		at(n - 2)?.kind === "dot" &&
		at(n - 3)?.kind === "ident" &&
		isRef(at(n - 4))
	) {
		return [keyword("on"), keyword("as")];
	}

	// `on delete |` / `on update |` → règles de cascade (seulement si un `ref`
	// précède dans la clause courante — sinon `on` est un join `on`).
	const prev = at(n - 2);
	if (
		(last.kind === "ident" || last.kind === "verb") &&
		(last.value.toLowerCase() === "delete" ||
			last.value.toLowerCase() === "update") &&
		prev?.kind === "keyword" &&
		prev.value === "on" &&
		refPrecedesInField(toks)
	) {
		return [keyword("cascade"), keyword("restrict"), keyword("set null")];
	}

	// `ref X.y on |` → `delete` / `update`.
	if (
		last.kind === "keyword" &&
		last.value === "on" &&
		refPrecedesInField(toks)
	) {
		return [keyword("delete"), keyword("update")];
	}

	return null;
}

/** Vrai si un `ref` apparaît dans le field courant (depuis le dernier `{`,
 * `,` ou début). Évite de confondre un `on delete` de ref avec un join `on`. */
function refPrecedesInField(toks: readonly Token[]): boolean {
	for (let i = toks.length - 1; i >= 0; i--) {
		const t = toks[i];
		if (t === undefined) return false;
		if (t.kind === "lbrace" || t.kind === "comma") return false;
		if (t.kind === "ident" && t.value.toLowerCase() === "ref") return true;
	}
	return false;
}

function isInsidePrimaryKeyParens(toks: readonly Token[]): boolean {
	for (let i = toks.length - 1; i >= 0; i--) {
		const t = toks[i];
		if (t === undefined) return false;
		if (t.kind === "lparen") {
			const before1 = toks[i - 1];
			const before2 = toks[i - 2];
			return (
				before1?.kind === "ident" &&
				before1.value.toLowerCase() === "key" &&
				before2?.kind === "keyword" &&
				before2.value === "primary"
			);
		}
		if (t.kind !== "ident" && t.kind !== "comma") return false;
	}
	return false;
}

function primaryKeyFieldSuggestions(
	toks: readonly Token[]
): readonly SnqlCompletion[] {
	const bodyStart = toks.findIndex((t) => t.kind === "lbrace");
	if (bodyStart < 0) return [];
	const declaredFields: string[] = [];
	for (let i = bodyStart + 1; i < toks.length; i++) {
		const t = toks[i];
		if (t?.kind === "colon" && i > 0) {
			const prev = toks[i - 1];
			if (prev?.kind === "ident") declaredFields.push(prev.value);
		}
	}
	const alreadyInPk = new Set<string>();
	let inPk = false;
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if (t === undefined) continue;
		if (t.kind === "lparen") {
			const before1 = toks[i - 1];
			const before2 = toks[i - 2];
			if (
				before1?.kind === "ident" &&
				before1.value.toLowerCase() === "key" &&
				before2?.kind === "keyword" &&
				before2.value === "primary"
			) {
				inPk = true;
				continue;
			}
		}
		if (inPk && t.kind === "ident") alreadyInPk.add(t.value);
	}
	return declaredFields
		.filter((f) => !alreadyInPk.has(f))
		.map((label) => ({
			label,
			type: "field" as const,
			detail: "field du body"
		}));
}

/** Complétions pour `add column X int [modifiers] into T` (DDL/2). */
function addColumnCompletions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] {
	const last = toks[toks.length - 1];
	if (last === undefined) return [];

	// `add column |` → nom de nouvelle col (libre).
	if (toks.length === 2) return [];

	// `add column X |` → types SNQL + aliases (D6) + enums en scope (Enum/2b).
	if (toks.length === 3 && last.kind === "ident") {
		return ddlTypeSuggestions(schema);
	}

	// `add column X TYPE |` → modifiers + `into`.
	// Détecte : dernier token est un ident (probablement type) et pas de `into` vu.
	const hasInto = toks.some((t) => t.kind === "keyword" && t.value === "into");
	if (!hasInto) {
		return [...DDL_FIELD_MODIFIERS.map(keyword), keyword("into")];
	}

	// `add column X TYPE into |` → collections cibles.
	if (last.kind === "keyword" && last.value === "into") {
		return collections(schema);
	}

	return [];
}

/** Complétions pour `add [unique] index (cols) into T` (DDL/3). */
function addIndexCompletions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] {
	const last = toks[toks.length - 1];
	if (last === undefined) return [];

	// `add unique |` → `index`
	if (
		toks.length === 2 &&
		last.kind === "ident" &&
		last.value.toLowerCase() === "unique"
	) {
		return [keyword("index")];
	}

	// `add [unique] index |` → `(`
	if (last.kind === "ident" && last.value.toLowerCase() === "index") {
		return [{ label: "(", type: "keyword" }];
	}

	// `add [unique] index (cols) |` OU `... into |`
	if (last.kind === "rparen") {
		return [keyword("into")];
	}
	if (last.kind === "keyword" && last.value === "into") {
		return collections(schema);
	}

	return [];
}

/**
 * Complétions pour `add ref (<col>) references <t>.<c> [on …] [as …] into <T>`
 * (ADR-036 E/1a). La table porteuse vient après `into` : la colonne entre
 * parenthèses n'est proposée que si `into <T>` est déjà écrit après le
 * curseur. Les règles `on delete|update` passent par `refClauseCompletions`
 * (le `ref` de tête ouvre la clause).
 */
function addRefCompletions(
	toks: readonly Token[],
	schema: SchemaModel,
	suffixToks: readonly Token[]
): readonly SnqlCompletion[] {
	const n = toks.length;
	const last = toks[n - 1];
	if (last === undefined) return [];
	const at = (i: number): Token | undefined => toks[i];
	const isReferences = (t: Token | undefined): boolean =>
		t !== undefined &&
		t.kind === "ident" &&
		t.value.toLowerCase() === "references";

	if (n === 2) return [{ label: "(", type: "keyword" }];
	if (last.kind === "lparen" && n === 3) {
		const into = suffixToks.findIndex(
			(t) => t.kind === "keyword" && t.value === "into"
		);
		const target = into >= 0 ? suffixToks[into + 1] : undefined;
		return target?.kind === "ident"
			? refTargetColumns(schema, target.value)
			: [];
	}
	if (last.kind === "rparen" && n === 5) return [keyword("references")];
	if (!toks.some(isReferences)) return [];
	if (last.kind === "keyword" && last.value === "into") {
		return collections(schema);
	}
	if (at(n - 2)?.kind === "keyword" && at(n - 2)?.value === "into") return [];
	if (isReferences(last)) return collections(schema);
	const table = at(n - 2);
	if (
		last.kind === "dot" &&
		table?.kind === "ident" &&
		isReferences(at(n - 3))
	) {
		return refTargetColumns(schema, table.value);
	}
	const clause = refClauseCompletions(toks, schema);
	if (clause !== null) return clause;
	if (last.kind === "keyword" && last.value === "as") return [];
	return [keyword("on"), keyword("as"), keyword("into")];
}

/**
 * Complétions pour `rename column <t>.<c> to <n>` (ADR-036 E/1b). Les
 * colonnes après `<t>.` passent par `dottedPathOptions`.
 */
function renameColumnCompletions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] {
	const n = toks.length;
	const last = toks[n - 1];
	if (n === 2) return collections(schema);
	if (n === 5 && last?.kind === "ident" && toks[3]?.kind === "dot") {
		return [keyword("to")];
	}
	return [];
}

const DEFAULT_FUNCTION_DETAIL = {
	now: "date de l'insertion",
	uuid: "uuid généré à l'insertion"
} as const;

/**
 * Défauts fonction (ADR-036 D4) que le lower accepte pour cette colonne :
 * `now()` sur une date, `uuid()` sur un uuid ou un texte. Colonne inconnue →
 * les deux, le lower tranchera.
 */
function defaultFunctionSuggestions(
	schema: SchemaModel,
	table: string | undefined,
	column: string | undefined
): readonly SnqlCompletion[] {
	const type = schema.collections
		.find((c) => c.name === table)
		?.fields.find((f) => f.name === column)?.type;
	return (["now", "uuid"] as const)
		.filter(
			(fn) =>
				type === undefined ||
				type === "unknown" ||
				DDL_DEFAULT_FUNCTIONS[fn]?.accepts.includes(type)
		)
		.map((fn) => ({
			label: `${fn}()`,
			type: "keyword",
			detail: DEFAULT_FUNCTION_DETAIL[fn]
		}));
}

/**
 * Complétions pour `alter column <t>.<c> set nullable | set not null | set
 * type <type> | set default <valeur> | drop default` (ADR-036 E/1c, E/1d).
 * Les colonnes après `<t>.` passent par `dottedPathOptions`.
 */
function alterColumnCompletions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] {
	const n = toks.length;
	const last = toks[n - 1];
	if (n === 2) return collections(schema);
	if (n === 5 && last?.kind === "ident" && toks[3]?.kind === "dot") {
		return [keyword("set"), keyword("drop")];
	}
	if (n === 6 && last?.kind === "keyword" && last.value === "set") {
		return [
			keyword("nullable"),
			keyword("not null"),
			keyword("type"),
			keyword("default")
		];
	}
	if (n === 6 && last?.value.toLowerCase() === "drop")
		return [keyword("default")];
	if (n === 7 && last?.value.toLowerCase() === "type") {
		return ddlTypeSuggestions(schema);
	}
	if (n === 7 && last?.kind === "keyword" && last.value === "default") {
		return defaultFunctionSuggestions(schema, toks[2]?.value, toks[4]?.value);
	}
	return [];
}

/** Complétions pour `drop table T [if exists]` (DDL/4). */
function dropTableCompletions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] {
	const last = toks[toks.length - 1];
	if (last === undefined) return [];

	// `drop table |` → collections existantes (contrairement à create).
	if (toks.length === 2) return collections(schema);

	// `drop table X |` → `if exists`.
	if (toks.length === 3 && last.kind === "ident") {
		return [keyword("if")];
	}

	return [];
}

/** Complétions pour `drop column X from T [if exists]` (DDL/4). */
function dropColumnCompletions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] {
	const last = toks[toks.length - 1];
	if (last === undefined) return [];

	// `drop column |` → nom col (libre).
	if (toks.length === 2) return [];

	// `drop column X |` → `from`.
	if (toks.length === 3 && last.kind === "ident") {
		return [keyword("from")];
	}

	// `drop column X from |` → collections.
	if (last.kind === "keyword" && last.value === "from") {
		return collections(schema);
	}

	return [];
}

/** Complétions pour `drop index NAME from T [if exists]` (DDL/3). */
function dropIndexCompletions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] {
	const last = toks[toks.length - 1];
	if (last === undefined) return [];

	// `drop index |` → nom index (libre, l'user connaît son index).
	if (toks.length === 2) return [];

	// `drop index NAME |` → `from`.
	if (toks.length === 3 && last.kind === "ident") {
		return [keyword("from")];
	}

	// `drop index NAME from |` → collections.
	if (last.kind === "keyword" && last.value === "from") {
		return collections(schema);
	}

	return [];
}

/**
 * Complétions pour `drop ref <fk_name> from <table> [if exists]` (FK/3).
 * Positions :
 *  - `drop ref |` : refs déclarées en scope (noms + navigation).
 *  - `drop ref NAME |` : `from`.
 *  - `drop ref NAME from |` : la table porteuse de NAME si connue, sinon
 *    toutes les collections.
 *  - `drop ref NAME from T |` : `if`.
 *  - `drop ref NAME from T if |` : `exists`.
 */
function dropRefCompletions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] {
	const last = toks[toks.length - 1];
	if (last === undefined) return [];

	// `drop ref |` → refs déclarées en scope.
	if (toks.length === 2) return refSuggestions(schema);

	// `drop ref NAME |` → `from`.
	if (toks.length === 3 && last.kind === "ident") {
		return [keyword("from")];
	}

	// `drop ref NAME from |` → la fromCollection de NAME si résolue (précis),
	// sinon toutes les collections (schema absent/stale).
	if (last.kind === "keyword" && last.value === "from") {
		const nameTok = toks[2];
		const named =
			nameTok !== undefined
				? schema.refs?.find((r) => r.name === nameTok.value)
				: undefined;
		if (named !== undefined) {
			return [
				{
					label: named.fromCollection,
					type: "collection" as const,
					detail: `porte ${named.name}`
				}
			];
		}
		return collections(schema);
	}

	// `drop ref NAME from T |` → `if`.
	if (toks.length === 5 && last.kind === "ident") {
		return [keyword("if")];
	}

	// `drop ref NAME from T if |` → `exists`.
	if (
		toks.length === 6 &&
		last.kind === "ident" &&
		last.value.toLowerCase() === "if"
	) {
		return [keyword("exists")];
	}

	return [];
}

/**
 * Complétions pour `add enum member <Name> "m" [if not exists]` (Enum/3).
 * Positions :
 *  - `add |` : proposé au dispatch DML top-level (add {...}).
 *  - `add enum |` : `member`.
 *  - `add enum member |` : enums en scope.
 *  - `add enum member Name |` : rien (member string libre).
 *  - `add enum member Name "m" |` : `if`.
 *  - `add enum member Name "m" if |` : `not`.
 *  - `add enum member Name "m" if not |` : `exists`.
 */
function addEnumMemberCompletions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] {
	const last = toks[toks.length - 1];
	if (last === undefined) return [];

	// `add enum |` → `member`.
	if (toks.length === 2) {
		return [keyword("member")];
	}

	// `add enum member |` → enums en scope.
	if (toks.length === 3 && last.kind === "ident") {
		return enumSuggestions(schema);
	}

	// `add enum member NAME |` → member string libre — rien à proposer.
	if (toks.length === 4 && last.kind === "ident") {
		return [];
	}

	// `add enum member NAME "m" |` → `if`.
	if (toks.length === 5 && last.kind === "string") {
		return [keyword("if")];
	}

	// `add enum member NAME "m" if |` → `not`.
	if (
		toks.length === 6 &&
		last.kind === "ident" &&
		last.value.toLowerCase() === "if"
	) {
		return [keyword("not")];
	}

	// `add enum member NAME "m" if not |` → `exists`.
	if (toks.length === 7 && last.kind === "keyword" && last.value === "not") {
		return [keyword("exists")];
	}

	return [];
}

/**
 * Complétions pour `drop enum <name> [if exists] [cascade]` (Enum/3 D8).
 * Positions :
 *  - `drop enum |` : enums en scope.
 *  - `drop enum NAME |` : `if` + `cascade`.
 *  - `drop enum NAME if |` : `exists`.
 *  - `drop enum NAME if exists |` : `cascade`.
 */
function dropEnumCompletions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] {
	const last = toks[toks.length - 1];
	if (last === undefined) return [];

	// `drop enum |` → enums en scope.
	if (toks.length === 2) return enumSuggestions(schema);

	// `drop enum NAME |` → `if` + `cascade`.
	if (toks.length === 3 && last.kind === "ident") {
		return [keyword("if"), keyword("cascade")];
	}

	// `drop enum NAME if |` → `exists`.
	if (
		toks.length === 4 &&
		last.kind === "ident" &&
		last.value.toLowerCase() === "if"
	) {
		return [keyword("exists")];
	}

	// `drop enum NAME if exists |` → `cascade`.
	if (toks.length === 5 && last.kind === "keyword" && last.value === "exists") {
		return [keyword("cascade")];
	}

	return [];
}
