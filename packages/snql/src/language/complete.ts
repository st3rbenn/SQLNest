/**
 * Language service — complétion SNQL **schema-aware**, pure et testable.
 *
 * L'éditeur manipule en permanence du SNQL **incomplet/invalide** (`get users |
 * where a` + curseur). Plutôt qu'une grammaire d'éditeur séparée, on
 * **réutilise le lexer du cœur** (`tokenize`) pour lire le contexte au curseur :
 * le lexer EST le Token Dictionary → une seule source de vérité, zéro dérive
 * entre deux grammaires. Le [[SchemaModel]] fournit les candidats (collections,
 * champs, relations).
 *
 * Pur : `(source, offset, schema) → candidats`. Le pont CodeMirror (front) n'est
 * qu'une fine couche d'affichage par-dessus.
 */

import { type OperationKind, verbOperation } from "../lexer/dictionary";
import { tokenize } from "../lexer/lexer";
import type { Token } from "../lexer/token";
import { SNQL_TYPE_ALIAS } from "../parser/parser";
import type { SchemaModel } from "../schema/model";

export type SnqlCompletionType =
	| "verb"
	| "keyword"
	| "collection"
	| "field"
	| "relation"
	| "alias";

export interface SnqlCompletion {
	/** Ce qui s'affiche dans la liste. */
	readonly label: string;
	readonly type: SnqlCompletionType;
	/** Annotation à droite (type du champ, cible d'une relation…). */
	readonly detail?: string;
	/** Texte réellement inséré si différent du label (ex. clause `on` complète). */
	readonly apply?: string;
	/**
	 * hint pour un renderer surface (CM6) qui veut fabriquer
	 * un apply function smart (auto-indent, guillemets pour string, curseur
	 * positionné). Absent = pas de smart-apply, le renderer insère `label` nu.
	 *  - "string" : type texte/uuid/enum — insérer `label: "|"` (curseur entre guillemets)
	 *  - "number" : type numeric/bool/date/json — insérer `label: |` (curseur après space)
	 *  - "raw"    : type inconnu — insérer `label: |` sans quotes
	 */
	readonly insertKind?: "string" | "number" | "raw";
}

export interface SnqlCompletionResult {
	/** Offset de début du mot courant : la zone que la complétion remplace. */
	readonly from: number;
	readonly options: readonly SnqlCompletion[];
}

/** Verbes proposés en début de requête (canonique par opération). */
const PRIMARY_VERBS: readonly {
	label: string;
	detail: string;
	type?: SnqlCompletionType;
}[] = [
	{ label: "get", detail: "lecture" },
	{ label: "add", detail: "insertion / DDL column / DDL index" },
	{ label: "update", detail: "mise à jour" },
	{ label: "remove", detail: "suppression" },
	// T3 introspection : soft-keywords, taggés `keyword` (pas verb CRUD) —
	// affichés avec l'icône keyword mais dans la même palette top-level.
	{ label: "list", detail: "introspection", type: "keyword" },
	{ label: "describe", detail: "introspection", type: "keyword" },
	// `raw` escape hatch — dernier recours documenté.
	{ label: "raw", detail: "escape hatch (SQL/Mongo brut)", type: "keyword" },
	// `let` — CTE binding, préfixe une requête plus grosse.
	{ label: "let", detail: "CTE (let x = find ...; body)", type: "keyword" },
	// DDL Tier-2 (ADR-029 DDL/5). `create` est verb insert-alias mais utile
	// aussi pour `create table T {...}` — le peek `table` route en DDL. `drop`
	// reste soft-ident (peekIdent au dispatch) — head-of-statement only.
	{ label: "create", detail: "DDL create table", type: "keyword" },
	{ label: "drop", detail: "DDL drop table/column/index (destructif)", type: "keyword" }
];

/**
 * Types SNQL suggestibles après `<col>: ` dans un body `create table` ou
 * après `add column X ` (ADR-029 DDL/5). Source unique = `SNQL_TYPE_ALIAS`
 * exporté par parser.ts — évite la dérive complete ↔ parser. Ordre : d'abord
 * canoniques puis aliases PG paste-friendly, séparés visuellement par `detail`.
 */
function ddlTypeSuggestions(): readonly SnqlCompletion[] {
	const canonicals: ReadonlySet<string> = new Set([
		"string",
		"int",
		"bigint",
		"float",
		"decimal",
		"bool",
		"date",
		"json",
		"array",
		"uuid",
		"enum",
		"unknown"
	]);
	return Object.keys(SNQL_TYPE_ALIAS).map((label) => ({
		label,
		type: "keyword" as const,
		detail: canonicals.has(label)
			? "type SNQL"
			: `alias PG → ${SNQL_TYPE_ALIAS[label]}`
	}));
}

/** Modifiers de field (create table body + add column) — ADR-029 D0. */
const DDL_FIELD_MODIFIERS: readonly string[] = [
	"nullable",
	"not",
	"default",
	"unique"
];

/** Sous-commandes reconnues après `list`. */
const LIST_SUBCOMMANDS: readonly string[] = [
	"tables",
	"schemas",
	"indexes",
	"databases",
	"schema_events"
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

/** Étapes valides par opération, dans l'ordre canonique imposé par le parser. */
const STAGES: Readonly<Record<OperationKind, readonly string[]>> = {
	select: ["with", "where", "sort", "pick", "limit"],
	update: ["where", "set"],
	delete: ["where"],
	insert: []
};

/** Mots-clés de stage (utilisés pour détecter l'étape active dans un flux tokens). */
const STAGE_KEYWORDS: ReadonlySet<string> = new Set([
	"with",
	"where",
	"sort",
	"pick",
	"limit",
	"set"
]);

/** Mot courant en cours de frappe (identifiant) juste avant le curseur. */
const TRAILING_WORD = /[A-Za-z0-9_]*$/;

/**
 * Candidats de complétion au décalage `offset` dans `source`, contextualisés par
 * le `schema`. Ne lève jamais : sur entrée non tokenisable, renvoie une liste
 * vide (from correct) plutôt qu'une erreur.
 */
export function completeSnql(
	source: string,
	offset: number,
	schema: SchemaModel
): SnqlCompletionResult {
	const at = Math.max(0, Math.min(offset, source.length));
	const prefix = source.slice(0, at);
	const word = TRAILING_WORD.exec(prefix)?.[0] ?? "";
	const from = at - word.length;

	// Chemin pointé (`alias.` / `col.`) : pas de complétion de champ imbriqué en v1.
	if (from > 0 && source[from - 1] === ".") {
		return { from, options: [] };
	}

	// le smart-apply insère `col: "|"` avec curseur entre
	// guillemets — le préfixe contient alors un `"` ouvert que le lexer refuse
	// (`lex_unterminated_string`). On détecte le cas via un compte des `"` non
	// échappés dans le préfixe (impair = string ouverte) et on ajoute une
	// fermeture heuristique pour tokeniser proprement.
	let toks: Token[];
	const prefixSlice = source.slice(0, from);
	const insideOpenString = isInsideOpenString(prefixSlice);
	const prefixForLex = insideOpenString ? prefixSlice + '"' : prefixSlice;
	try {
		toks = tokenize(prefixForLex).filter((t) => t.kind !== "eof");
	} catch {
		return { from, options: [] };
	}

	// pour un `add {...} into t`, l'user tape souvent le doc
	// AVANT `into t`. On tokenise aussi le suffixe pour retrouver la target,
	// sinon on ne pourrait rien proposer dans un doc quand l'user commence par
	// `add {|`. Silence si suffixe non-tokenisable.
	let suffixToks: Token[] = [];
	// si le curseur est dans une string ouverte, le suffixe
	// démarre par le reste de la string (jusqu'au `"` fermant). Skippe-le
	// pour tokeniser proprement le reste (`into resource`).
	const suffixSlice = insideOpenString
		? skipToClosingQuote(source, at)
		: source.slice(at);
	try {
		suffixToks = tokenize(suffixSlice).filter((t) => t.kind !== "eof");
	} catch {
		// Suffixe cassé — pas grave, on tentera la détection sur le préfixe seul.
	}

	return {
		from,
		options: contextOptions(toks, schema, suffixToks, insideOpenString)
	};
}

/**
 * true ssi le curseur est à l'intérieur d'une string
 * ouverte (nombre impair de `"` non-échappés dans le préfixe). Ignore les
 * quotes échappées `\"`. Simple mais suffisant : les single-quotes SNQL
 * suivent le même contrat et sont couvertes symétriquement plus tard si
 * besoin (v1 : `"` uniquement, cf. surface JSON-y du doc d'insert).
 */
function isInsideOpenString(prefix: string): boolean {
	let count = 0;
	let escaped = false;
	for (const ch of prefix) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') count += 1;
	}
	return count % 2 === 1;
}

/** Depuis `at`, skip jusqu'au prochain `"` non-échappé (fin de string ouverte). */
function skipToClosingQuote(source: string, at: number): string {
	let i = at;
	let escaped = false;
	while (i < source.length) {
		const ch = source[i]!;
		if (escaped) {
			escaped = false;
		} else if (ch === "\\") {
			escaped = true;
		} else if (ch === '"') {
			return source.slice(i + 1);
		}
		i += 1;
	}
	return "";
}

/** Détermine les candidats à partir du flux de tokens qui précède le mot courant. */
function contextOptions(
	toks: readonly Token[],
	schema: SchemaModel,
	suffixToks: readonly Token[] = [],
	insideOpenString = false
): readonly SnqlCompletion[] {
	const last = toks[toks.length - 1];
	if (last === undefined) {
		return verbs();
	}

	const operation = operationOf(toks);
	const scope = extractScope(toks, operation);

	// contexte doc d'insert (`add {…}`) ou set d'update
	// (`update t set c1 = …, c2 = …`) — propose les cols de la target avec
	// badges obligatoire/facultatif, skip celles déjà tapées.
	const docCtx = insertDocContext(toks, suffixToks);
	if (docCtx !== null) {
		return docCompletions(docCtx, schema, last, insideOpenString);
	}
	const setCtx = updateSetContext(toks, operation, scope);
	if (setCtx !== null) {
		return setCompletions(setCtx, schema, last, insideOpenString);
	}

	// DDL/5 (ADR-029) — patterns spécifiques DDL détectés avant les cases DML
	// génériques : le pattern matching top-level doit prendre le dessus car
	// certains keywords partagés (`into`/`from`/`unique`) ont un sens DDL vs
	// DML. On lookup à partir du 1er token pour discriminer.
	const ddlOptions = ddlContextOptions(toks, schema);
	if (ddlOptions !== null) return ddlOptions;

	// +introspection verbs (soft-keyword). En tête de statement
	// uniquement — les mots `list`/`describe` restent utilisables comme
	// idents ailleurs (ex. `pick x as list`), donc pas de spécial-case au-delà.
	// DDL/5 : `drop` reste soft-ident head-of-statement — propose table/column/index.
	if (last.kind === "ident" && toks.length === 1) {
		const lower = last.value.toLowerCase();
		if (lower === "list") {
			return LIST_SUBCOMMANDS.map(keyword);
		}
		if (lower === "describe") {
			return collections(schema);
		}
		if (lower === "drop") {
			// ADR-029 D7 destructive — WriteConfirmBar D7 typing gate au run.
			return [keyword("table"), keyword("column"), keyword("index")];
		}
	}

	// après une commande d'introspection, dispatch spécifique — les
	// stages `pick`/`where`/`sort` réfèrent aux cols du shape de sortie, pas
	// aux cols d'une collection schema (qui n'existent pas ici).
	// `for <col1>, <col2>` propose les cols de la table cible.
	const introContext = introspectContextOf(toks);
	if (introContext !== null) {
		// `list indexes on |` → collections (la table cible du filter).
		if (
			introContext.kind === "list-indexes" &&
			last.kind === "keyword" &&
			last.value === "on"
		) {
			return collections(schema);
		}
		// `for a, |` OU `describe X for |` — propose les cibles du shortcut.
		if (
			(last.kind === "comma" || last.kind === "ident") &&
			lastKeywordIsFor(toks)
		) {
			return forShortcutTargets(introContext, schema);
		}
		if (last.kind === "keyword") {
			if (last.value === "pick" || last.value === "where" || last.value === "sort") {
				return introspectFields(introContext.shape);
			}
			return remainingIntrospectStages(toks);
		}
		if (last.kind === "comma") {
			// Prolongement de liste pick/sort — mêmes cols du shape.
			if (introActiveStage(toks) === "pick" || introActiveStage(toks) === "sort") {
				return introspectFields(introContext.shape);
			}
			return [];
		}
		if (last.kind === "ident" || last.kind === "number" || last.kind === "rparen") {
			return remainingIntrospectStages(toks);
		}
	}

	// Un verbe ne pilote le contexte qu'en **tête de requête**. Le lexer classe
	// `verb` tout synonyme (create, edit, delete…) où qu'il apparaisse : sans ce
	// garde, un ident nommé comme un verbe proposerait des collections.
	if (last.kind === "verb" && toks.length === 1) {
		const op = verbOperation(last.value);
		const lower = last.value.toLowerCase();
		// DDL/5 : `create` verb → propose `table` en tête (peek `table` route en
		// parseCreateTable au parser ; sinon `create {doc} into T` reste insert
		// alias, on garde donc aussi un doc `{` implicit — non complété ici).
		if (lower === "create") {
			return [keyword("table")];
		}
		// DDL/5 : `add` verb → étend l'insert alias avec les sub-cmds DDL/2+DDL/3
		// (`column` / `index` / `unique index`) tout en gardant les collections
		// cibles pour l'insert `add {...} into T` classique.
		if (lower === "add") {
			return [
				keyword("column"),
				keyword("index"),
				keyword("unique"),
				...collections(schema)
			];
		}
		// `get <coll>` / `update <coll>` : le mot suivant est la collection cible.
		if (op === "select" || op === "update") {
			return collections(schema);
		}
		if (op === "delete") {
			return [keyword("from")];
		}
		return [];
	}

	if (last.kind === "keyword") {
		// `and` a deux rôles : chaînage entre joins (`with A on … and B on …`) ou
		// opérateur booléen dans un prédicat. On propose les collections jointes
		// (avec l'escape hatch `one`/`many` en tête) uniquement quand on est
		// encore en clause `with`.
		if (last.value === "and" && isChainingJoin(toks)) {
			return withCollectionSuggestions(schema, scope);
		}
		// `one` / `many` : escape hatch de multiplicité de `with`. On ne propose
		// les collections QUE si le mot suit vraiment un `with` (ou un `and` de
		// chaînage) — sinon c'est un usage errant qui ne pilote pas le contexte.
		if (
			(last.value === "one" || last.value === "many") &&
			isMultiplicityAfterWith(toks)
		) {
			return joinTargets(schema, scope);
		}
		return keywordContext(last.value, schema, scope);
	}

	if (last.kind === "comma") {
		// Continuation d'une liste : dépend de l'étape active.
		return commaContext(toks, schema, scope);
	}

	if (last.kind === "op" && last.value === "=") {
		// `on <local> = <foreign>` : le membre droit est un champ de la collection jointe.
		const foreign = onForeignCollection(toks);
		if (foreign !== undefined) {
			return fieldsOf(schema, foreign);
		}
		return [];
	}

	if (last.kind === "lparen") {
		// Ouverture d'un groupe dans un prédicat : un champ suit, comme après `where`.
		return fields(schema, scope, false);
	}

	if (last.kind === "rbrace" || last.kind === "rbracket") {
		// Document d'insert refermé : la seule suite valide est `into <collection>`
		// (parseInsert). Tant qu'une liste `[ … ]` reste ouverte, on attend `,`/`]`.
		if (operation === "insert" && !hasOpenBracket(toks)) {
			return [keyword("into")];
		}
		return [];
	}

	if (last.kind === "ident" || last.kind === "number" || last.kind === "rparen") {
		// Fin d'une valeur, d'une source, ou d'un chemin de champ : propose les
		// stages restants dans l'ordre canonique (moins ceux déjà présents).
		return remainingStages(toks, operation);
	}

	return [];
}

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
function introspectContextOf(toks: readonly Token[]): IntrospectContext | null {
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
function forShortcutTargets(
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
function lastKeywordIsFor(toks: readonly Token[]): boolean {
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
function introspectFields(cols: readonly string[]): readonly SnqlCompletion[] {
	return cols.map((name) => ({ label: name, type: "field" as const }));
}

/** Stages introspect non encore consommés, dans l'ordre canonique. */
function remainingIntrospectStages(
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
	if (
		ctx?.kind === "list-indexes" &&
		!sawOn &&
		!sawFor &&
		seen.size === 0
	) {
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
function introActiveStage(toks: readonly Token[]): string | undefined {
	for (let i = toks.length - 1; i >= 0; i -= 1) {
		const t = toks[i];
		if (t?.kind === "keyword" && INTROSPECT_STAGES.includes(t.value)) {
			return t.value;
		}
	}
	return undefined;
}

/** Stages non encore consommés pour l'opération courante, dans l'ordre canonique. */
function remainingStages(
	toks: readonly Token[],
	operation: OperationKind | undefined
): readonly SnqlCompletion[] {
	const available = operation ? STAGES[operation] : STAGES.select;
	const seen = new Set<string>();
	for (const tok of toks) {
		if (tok.kind === "keyword" && available.includes(tok.value)) {
			seen.add(tok.value);
		}
	}
	// `with` est répétable via `and` — pas de restriction sur lui.
	return available
		.filter((stage) => stage === "with" || !seen.has(stage))
		.map(keyword);
}

/**
 * Après `with ` ou après un `and` de chaînage de join, on propose l'escape hatch
 * de multiplicité en tête (`one`, `many`) suivi des collections liées. Ordre :
 * les mots-clés d'abord (courts, ils débloquent l'inférence forcée), puis les
 * cibles de jointure schema-aware.
 */
function withCollectionSuggestions(
	schema: SchemaModel,
	scope: Scope
): readonly SnqlCompletion[] {
	return [
		multiplicityKeyword("one"),
		multiplicityKeyword("many"),
		...joinTargets(schema, scope)
	];
}

function multiplicityKeyword(value: "one" | "many"): SnqlCompletion {
	return {
		label: value,
		type: "keyword",
		detail:
			value === "one"
				? "force LEFT JOIN (row unique)"
				: "force embed array (many rows)"
	};
}

/**
 * Vrai si le `one`/`many` en fin de flux suit directement un `with` ou un `and`
 * de chaînage — c'est le seul contexte où l'escape hatch de multiplicité est
 * valide. Un `one`/`many` ailleurs (mot-clé mais hors syntaxe) ne doit pas
 * proposer de collections, sinon la complétion devient surprenante.
 */
function isMultiplicityAfterWith(toks: readonly Token[]): boolean {
	const prev = toks[toks.length - 2];
	if (prev === undefined || prev.kind !== "keyword") {
		return false;
	}
	if (prev.value === "with") {
		return true;
	}
	// `and` — n'est un chaînage que si le contexte `with` est actif avec un `on
	// … = …` complet AVANT le `and`. On réutilise `isChainingJoin` en enlevant
	// notre `one`/`many` du flux pour reconstruire "..., and" et le tester.
	if (prev.value === "and") {
		return isChainingJoin(toks.slice(0, -1));
	}
	return false;
}

/**
 * Vrai si le `and` en fin de flux est un chaînage de joins (`with … on … = … and`),
 * plutôt qu'un opérateur booléen dans un prédicat. On regarde le dernier stage
 * ouvert : s'il s'agit d'un `with` et qu'une valeur foreign a été fournie, c'est
 * un chaînage.
 */
function isChainingJoin(toks: readonly Token[]): boolean {
	// L'`and` en question est le dernier token — on regarde ce qui précède.
	if (activeStage(toks.slice(0, -1)) !== "with") {
		return false;
	}
	// Un chaînage suit un `on <local> = <foreign>` complet : on cherche un `=`
	// après le dernier `on` ; s'il est là et qu'un ident/rien de « prédicat »
	// ne le sépare pas d'`and`, on est en position de chaînage.
	let sawOn = false;
	let sawEq = false;
	for (let i = 0; i < toks.length - 1; i += 1) {
		const t = toks[i];
		if (t?.kind === "keyword" && t.value === "on") {
			sawOn = true;
			sawEq = false;
		} else if (sawOn && t?.kind === "op" && t.value === "=") {
			sawEq = true;
		}
	}
	return sawOn && sawEq;
}

/** Une liste de documents `[ … ` est-elle encore ouverte ? */
function hasOpenBracket(toks: readonly Token[]): boolean {
	let depth = 0;
	for (const tok of toks) {
		if (tok.kind === "lbracket") {
			depth += 1;
		} else if (tok.kind === "rbracket") {
			depth -= 1;
		}
	}
	return depth > 0;
}

/** Candidats après un mot-clé donné (le dernier token). */
function keywordContext(
	kw: string,
	schema: SchemaModel,
	scope: Scope
): readonly SnqlCompletion[] {
	switch (kw) {
		case "from":
		case "into":
			return collections(schema);
		case "with":
			return withCollectionSuggestions(schema, scope);
		case "where":
		case "and":
		case "or":
		case "not":
			return fields(schema, scope, false);
		case "pick":
			return fields(schema, scope, true);
		case "sort":
		case "set":
			return fields(schema, scope, false);
		case "on":
			// Membre gauche = champ de la collection source.
			return fields(schema, scope, false);
		default:
			return [];
	}
}

/** Candidats après une virgule, selon l'étape active. */
function commaContext(
	toks: readonly Token[],
	schema: SchemaModel,
	scope: Scope
): readonly SnqlCompletion[] {
	switch (activeStage(toks)) {
		case "pick":
			return fields(schema, scope, true);
		case "sort":
		case "set":
			return fields(schema, scope, false);
		default:
			return [];
	}
}

// --- Portée : collection source + jointures ---------------------------------

interface Scope {
	readonly source: string | undefined;
	readonly joins: readonly { collection: string; alias?: string }[];
}

function operationOf(toks: readonly Token[]): OperationKind | undefined {
	const first = toks[0];
	return first?.kind === "verb" ? verbOperation(first.value) : undefined;
}

/** Extrait la collection source et les collections jointes du flux de tokens. */
function extractScope(
	toks: readonly Token[],
	operation: OperationKind | undefined
): Scope {
	let source: string | undefined;
	if (operation === "select" || operation === "update") {
		const t = toks[1];
		if (t?.kind === "ident") {
			source = t.value;
		}
	} else if (operation === "delete") {
		source = identAfter(toks, "from");
	} else if (operation === "insert") {
		source = identAfter(toks, "into");
	}

	const joins: { collection: string; alias?: string }[] = [];
	for (let i = 0; i < toks.length; i += 1) {
		if (toks[i]?.kind === "keyword" && toks[i]?.value === "with") {
			const coll = toks[i + 1];
			if (coll?.kind === "ident") {
				const asKw = toks[i + 2];
				const aliasTok = toks[i + 3];
				if (
					asKw?.kind === "keyword" &&
					asKw.value === "as" &&
					aliasTok?.kind === "ident"
				) {
					joins.push({ collection: coll.value, alias: aliasTok.value });
				} else {
					joins.push({ collection: coll.value });
				}
			}
		}
	}
	return { source, joins };
}

/** Premier `ident` suivant le mot-clé `kw`, s'il existe. */
function identAfter(toks: readonly Token[], kw: string): string | undefined {
	for (let i = 0; i < toks.length; i += 1) {
		if (toks[i]?.kind === "keyword" && toks[i]?.value === kw) {
			const next = toks[i + 1];
			return next?.kind === "ident" ? next.value : undefined;
		}
	}
	return undefined;
}

/** Dernier stage keyword vu — sans pipe, on scanne à rebours le flux. */
function activeStage(toks: readonly Token[]): string | undefined {
	for (let i = toks.length - 1; i >= 0; i -= 1) {
		const tok = toks[i];
		if (tok?.kind === "keyword" && STAGE_KEYWORDS.has(tok.value)) {
			return tok.value;
		}
	}
	return undefined;
}

/**
 * Dans l'étape `with` active, la collection jointe (l'ident après `with` ou après
 * un `and` de chaînage) — pour compléter le membre droit de `on <local> = <foreign>`.
 */
function onForeignCollection(toks: readonly Token[]): string | undefined {
	// L'introducteur du join courant est le dernier `with` OU le dernier `and`
	// en position de chaînage (les deux valides comme début d'un join).
	let introIdx = -1;
	for (let i = toks.length - 1; i >= 0; i -= 1) {
		const tok = toks[i];
		if (tok?.kind === "keyword" && (tok.value === "with" || tok.value === "and")) {
			introIdx = i;
			break;
		}
		// Si un autre stage keyword est plus récent, on n'est plus dans un with.
		if (tok?.kind === "keyword" && STAGE_KEYWORDS.has(tok.value)) {
			return undefined;
		}
	}
	if (introIdx === -1) {
		return undefined;
	}
	// On n'est en position « champ distant » que si `on` a déjà été vu depuis l'intro.
	let sawOn = false;
	for (let i = introIdx + 1; i < toks.length; i += 1) {
		if (toks[i]?.kind === "keyword" && toks[i]?.value === "on") {
			sawOn = true;
		}
	}
	if (!sawOn) {
		return undefined;
	}
	const coll = toks[introIdx + 1];
	return coll?.kind === "ident" ? coll.value : undefined;
}

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
function insertDocContext(
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
	const { position, currentColumn } = docCursorPosition(prefixToks, lastOpenIdx);
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
function updateSetContext(
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
		if (t.kind === "lbrace" || t.kind === "lbracket" || t.kind === "lparen") depth += 1;
		else if (t.kind === "rbrace" || t.kind === "rbracket" || t.kind === "rparen") depth -= 1;
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
function docCompletions(
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
	if (last.kind !== "lbrace" && last.kind !== "comma" && last.kind !== "ident") {
		return [];
	}
	return fieldsForDoc(schema, ctx);
}

/** Suggestions dans un `set` d'update. */
function setCompletions(
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
function insertKindOf(t: import("../schema/model").SnqlType): "string" | "number" | "raw" {
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

// --- Constructeurs de candidats ---------------------------------------------

function verbs(): readonly SnqlCompletion[] {
	return PRIMARY_VERBS.map((v) => ({
		label: v.label,
		type: v.type ?? ("verb" as const),
		detail: v.detail
	}));
}

function keyword(label: string): SnqlCompletion {
	return { label, type: "keyword" };
}

function collections(schema: SchemaModel): readonly SnqlCompletion[] {
	return schema.collections.map((c) => ({
		label: c.name,
		type: "collection" as const,
		detail: `${c.fields.length} champ${c.fields.length > 1 ? "s" : ""}`
	}));
}

/** Champs de la collection source (+ alias de jointure si `withAliases`). */
function fields(
	schema: SchemaModel,
	scope: Scope,
	withAliases: boolean
): readonly SnqlCompletion[] {
	const out: SnqlCompletion[] = [...fieldsOf(schema, scope.source)];
	if (withAliases) {
		for (const join of scope.joins) {
			out.push({
				label: join.alias ?? join.collection,
				type: "alias",
				detail: `→ ${join.collection}`
			});
		}
	}
	return out;
}

/** Champs d'une collection nommée (vide si inconnue). */
function fieldsOf(
	schema: SchemaModel,
	collection: string | undefined
): readonly SnqlCompletion[] {
	if (collection === undefined) {
		return [];
	}
	const found = schema.collections.find((c) => c.name === collection);
	if (found === undefined) {
		return [];
	}
	return found.fields.map((f) => ({
		label: f.name,
		type: "field" as const,
		detail: f.nullable ? `${f.type} ?` : f.type
	}));
}

/**
 * Cibles de jointure après `with` : les collections liées à la source (via une
 * relation du SchemaModel) d'abord, annotées et avec la clause `on` pré-remplie ;
 * puis les autres. Relies l'utilisateur au graphe de relations introspecté.
 */
function joinTargets(
	schema: SchemaModel,
	scope: Scope
): readonly SnqlCompletion[] {
	const related: SnqlCompletion[] = [];
	const others: SnqlCompletion[] = [];
	const relatedNames = new Set<string>();

	if (scope.source !== undefined) {
		for (const rel of schema.relations) {
			const link = orientRelation(rel, scope.source);
			if (link === undefined) {
				continue;
			}
			relatedNames.add(link.target);
			// Clause `on` pré-remplie seulement pour une relation à champ unique.
			const apply =
				link.local.length === 1 && link.foreign.length === 1
					? `${link.target} on ${link.local[0]} = ${link.foreign[0]}`
					: undefined;
			related.push({
				label: link.target,
				type: "relation",
				detail: `via ${link.local.join(",")} = ${link.foreign.join(",")}`,
				...(apply !== undefined ? { apply } : {})
			});
		}
	}

	for (const c of schema.collections) {
		if (c.name === scope.source || relatedNames.has(c.name)) {
			continue;
		}
		others.push({ label: c.name, type: "collection", detail: "collection" });
	}
	others.sort((a, b) => a.label.localeCompare(b.label));
	return [...related, ...others];
}

interface OrientedLink {
	readonly target: string;
	readonly local: readonly string[];
	readonly foreign: readonly string[];
}

/**
 * Oriente une relation depuis le point de vue de `source` : `local` = champ(s)
 * côté source, `foreign` = champ(s) côté collection jointe. undefined si la
 * relation ne touche pas la source.
 */
function orientRelation(
	rel: SchemaModel["relations"][number],
	source: string
): OrientedLink | undefined {
	if (rel.from.collection === source) {
		return {
			target: rel.to.collection,
			local: rel.from.fields,
			foreign: rel.to.fields
		};
	}
	if (rel.to.collection === source) {
		return {
			target: rel.from.collection,
			local: rel.to.fields,
			foreign: rel.from.fields
		};
	}
	return undefined;
}

/**
 * ADR-029 DDL/5 — Complétions contextuelles pour tous les DDL kinds. Détecte
 * le kind depuis les premiers tokens (create table / add column / add index /
 * drop table/column/index) et propose la suggestion appropriée selon la
 * position dans le pattern.
 *
 * Retourne `null` si le statement n'est pas un DDL — dispatch fallthrough
 * vers le pipeline DML classique.
 */
function ddlContextOptions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] | null {
	if (toks.length === 0) return null;
	const head = toks[0];
	if (head === undefined) return null;
	const headLower = head.value.toLowerCase();

	// === create table === (parseCreateTable dispatch = verb create + keyword table)
	if (head.kind === "verb" && headLower === "create" && toks.length >= 2) {
		const t1 = toks[1];
		if (t1 === undefined || t1.value.toLowerCase() !== "table") return null;
		return createTableCompletions(toks);
	}

	// === add column / add index / add unique index === (verb add + soft-ident)
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
		return null;
	}

	// === drop table / drop column / drop index === (soft-ident drop head)
	if (head.kind === "ident" && headLower === "drop" && toks.length >= 2) {
		const t1 = toks[1];
		if (t1 === undefined) return null;
		const t1Lower = t1.value.toLowerCase();
		if (t1Lower === "table") return dropTableCompletions(toks, schema);
		if (t1Lower === "column") return dropColumnCompletions(toks, schema);
		if (t1Lower === "index") return dropIndexCompletions(toks, schema);
		return null;
	}

	return null;
}

/** Complétions pour `create table X { … }` (DDL/1). */
function createTableCompletions(
	toks: readonly Token[]
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

	// `{ |` (juste après ouverture body) OU `, |` (après un field terminé) :
	// début de nouveau field. Le nom est libre (pas de suggestion précise),
	// mais on propose `primary key` qui est le seul keyword structurel valide
	// à cette position (D0 ADR-029). L'user peut aussi taper directement un
	// ident (nom de field) — pas de suggestion nécessaire pour ça.
	if (last.kind === "lbrace" || last.kind === "comma") {
		return [keyword("primary")];
	}

	// `{ col :` → types SNQL + aliases (D6).
	if (last.kind === "colon") return ddlTypeSuggestions();

	// `{ col: uuid |` OU `{ col: uuid nullable |` → modifiers + `,` + `primary`.
	// Détection : dernier token = ident de type, ou modifier connu.
	if (last.kind === "ident") {
		const prev = toks[toks.length - 2];
		if (prev !== undefined && prev.kind === "colon") {
			// On vient de taper le type — propose modifiers.
			return DDL_FIELD_MODIFIERS.map(keyword);
		}
		if (
			DDL_FIELD_MODIFIERS.includes(last.value.toLowerCase()) ||
			last.value.toLowerCase() === "null" ||
			last.value.toLowerCase() === "unique"
		) {
			// Après un modifier → autres modifiers restants.
			return DDL_FIELD_MODIFIERS.map(keyword);
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

/** Complétions pour `add column X int [modifiers] into T` (DDL/2). */
function addColumnCompletions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] {
	const last = toks[toks.length - 1];
	if (last === undefined) return [];

	// `add column |` → nom de nouvelle col (libre).
	if (toks.length === 2) return [];

	// `add column X |` → types SNQL + aliases (D6, corpus `add column X TYPE`).
	if (toks.length === 3 && last.kind === "ident") {
		return ddlTypeSuggestions();
	}

	// `add column X TYPE |` → modifiers + `into`.
	// Détecte : dernier token est un ident (probablement type) et pas de `into` vu.
	const hasInto = toks.some(
		(t) => t.kind === "keyword" && t.value === "into"
	);
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
