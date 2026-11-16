import { type OperationKind, verbOperation } from "../lexer/dictionary";
import { tokenize } from "../lexer/lexer";
import type { Token } from "../lexer/token";
import { getIncomingRefs, type SchemaModel } from "../schema/model";
import { ddlContextOptions } from "./complete-ddl";
import {
	docCompletions,
	insertDocContext,
	setCompletions,
	updateSetContext
} from "./complete-doc";
import {
	forShortcutTargets,
	introActiveStage,
	introspectContextOf,
	introspectFields,
	LIST_SUBCOMMANDS,
	lastKeywordIsFor,
	remainingIntrospectStages
} from "./complete-introspect";
import {
	collections,
	enumSuggestions,
	fieldsOf,
	keyword,
	refTargetColumns,
	type SnqlCompletion,
	type SnqlCompletionResult,
	verbs
} from "./complete-items";
import {
	activeStage,
	extractScope,
	fields,
	hasOpenBracket,
	joinTargets,
	onForeignCollection,
	operationOf,
	resolveDotTarget,
	type Scope,
	STAGES
} from "./complete-scope";
import { defined } from "../invariant";

export type {
	SnqlCompletion,
	SnqlCompletionResult,
	SnqlCompletionType
} from "./complete-items";

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

	// Chemin pointé (`head.` ). Forward-nav / join drill-in (ADR-031 D6, FK/2b) :
	// `pick user.|` / `pick u.|` → colonnes de la collection cible. Autres chemins
	// (accès JSON `meta.x`) → pas de complétion de champ imbriqué en v1.
	if (from > 0 && source[from - 1] === ".") {
		return {
			from,
			options: dottedPathOptions(source.slice(0, from - 1), schema)
		};
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
		const ch = defined(source[i]);
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
	const ddlOptions = ddlContextOptions(toks, schema, suffixToks);
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
			// Tables + le sous-verbe `enum` (sprint EN : `describe enum <name>`).
			return [...collections(schema), keyword("enum")];
		}
		if (lower === "rename" || lower === "alter") return [keyword("column")];
		if (lower === "drop") {
			// ADR-029 D7 destructive — WriteConfirmBar D7 typing gate au run.
			// Enum/3 ajoute `enum` (D8), FK/3 ajoute `ref`.
			return [
				keyword("table"),
				keyword("column"),
				keyword("index"),
				keyword("enum"),
				keyword("ref")
			];
		}
	}

	// `describe enum |` (sprint EN) → enums en scope — le nom exact (et sa
	// casse, ex. DISASTER_QUALIFICATION) devient découvrable sans deviner.
	if (
		toks.length === 2 &&
		toks[0]?.kind === "ident" &&
		toks[0].value.toLowerCase() === "describe" &&
		last.kind === "ident" &&
		last.value.toLowerCase() === "enum"
	) {
		return enumSuggestions(schema);
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
			if (
				last.value === "pick" ||
				last.value === "where" ||
				last.value === "sort"
			) {
				return introspectFields(introContext.shape);
			}
			return remainingIntrospectStages(toks);
		}
		if (last.kind === "comma") {
			// Prolongement de liste pick/sort — mêmes cols du shape.
			if (
				introActiveStage(toks) === "pick" ||
				introActiveStage(toks) === "sort"
			) {
				return introspectFields(introContext.shape);
			}
			return [];
		}
		if (
			last.kind === "ident" ||
			last.kind === "number" ||
			last.kind === "rparen"
		) {
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
				keyword("enum"),
				keyword("ref"),
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

	if (
		last.kind === "ident" ||
		last.kind === "number" ||
		last.kind === "rparen"
	) {
		// Fin d'une valeur, d'une source, ou d'un chemin de champ : propose les
		// stages restants dans l'ordre canonique (moins ceux déjà présents).
		return remainingStages(toks, operation);
	}

	return [];
}

/**
 * Complétion d'un chemin pointé `head.|` (ADR-031 D6 drill-in). `prefixBeforeDot`
 * = source jusqu'AVANT le `.`. Tokenise, extrait le head (dernier ident),
 * résout via nav/join et propose les colonnes de la cible. Select uniquement
 * (le `ref X.|` DDL a son propre chemin). Non résolu (accès JSON) → [].
 */
function dottedPathOptions(
	prefixBeforeDot: string,
	schema: SchemaModel
): readonly SnqlCompletion[] {
	let toks: Token[];
	try {
		toks = tokenize(prefixBeforeDot).filter((t) => t.kind !== "eof");
	} catch {
		return [];
	}
	const head = toks[toks.length - 1];
	if (head?.kind !== "ident") return [];
	// Cible d'une FK en DDL (`ref users.|`, `references users.|`) : colonnes
	// de la table nommée.
	const before = toks[toks.length - 2];
	if (before?.kind === "ident") {
		const kw = before.value.toLowerCase();
		if (kw === "ref" || kw === "references") {
			return refTargetColumns(schema, head.value);
		}
		// `rename column <t>.|` / `alter column <t>.|` (ADR-036).
		const verb = toks[toks.length - 3];
		if (
			kw === "column" &&
			verb?.kind === "ident" &&
			["rename", "alter"].includes(verb.value.toLowerCase())
		) {
			return refTargetColumns(schema, head.value);
		}
	}
	const operation = operationOf(toks);
	if (operation !== "select") return [];
	const scope = extractScope(toks, operation);
	const target = resolveDotTarget(head.value, schema, scope);
	if (target !== undefined) return fieldsOf(schema, target);
	// Reverse-nav drill-in (ADR-031 D7) : `orders.|` où orders référence la
	// source → propose `count` (seul agrégat reverse-nav V1).
	if (scope.source !== undefined) {
		for (const ref of getIncomingRefs(schema, scope.source)) {
			if (ref.fromCollection === head.value) {
				return [
					{ label: "count", type: "field", detail: `count des ${head.value}` }
				];
			}
		}
	}
	return [];
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
