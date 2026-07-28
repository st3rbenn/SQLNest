/**
 * Language service — complétion SNQL **schema-aware**, pure et testable.
 *
 * L'éditeur manipule en permanence du SNQL **incomplet/invalide** (`get users |
 * where a` + curseur). Plutôt qu'une grammaire d'éditeur séparée (ADR-009), on
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
}

export interface SnqlCompletionResult {
	/** Offset de début du mot courant : la zone que la complétion remplace. */
	readonly from: number;
	readonly options: readonly SnqlCompletion[];
}

/** Verbes proposés en début de requête (un par opération canonique). */
const PRIMARY_VERBS: readonly { label: string; detail: string }[] = [
	{ label: "get", detail: "lecture" },
	{ label: "find", detail: "lecture" },
	{ label: "add", detail: "insertion" },
	{ label: "update", detail: "mise à jour" },
	{ label: "remove", detail: "suppression" }
];

/** Étapes de pipeline valides après `|`, par opération. */
const STAGES: Readonly<Record<OperationKind, readonly string[]>> = {
	select: ["where", "with", "pick", "sort", "limit"],
	update: ["where", "set"],
	delete: ["where"],
	insert: []
};

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

	let toks: Token[];
	try {
		toks = tokenize(source.slice(0, from)).filter((t) => t.kind !== "eof");
	} catch {
		return { from, options: [] };
	}

	return { from, options: contextOptions(toks, schema) };
}

/** Détermine les candidats à partir du flux de tokens qui précède le mot courant. */
function contextOptions(
	toks: readonly Token[],
	schema: SchemaModel
): readonly SnqlCompletion[] {
	const last = toks[toks.length - 1];
	if (last === undefined) {
		return verbs();
	}

	const operation = operationOf(toks);
	const scope = extractScope(toks, operation);

	// Un verbe ne pilote le contexte qu'en **tête de requête**. Le lexer classe
	// `verb` tout synonyme (change, clear, edit…) où qu'il apparaisse : sans ce
	// garde, `… | where change ` proposerait des collections.
	if (last.kind === "verb" && toks.length === 1) {
		const op = verbOperation(last.value);
		// `get <coll>` / `update <coll>` : le mot suivant est la collection cible.
		if (op === "select" || op === "update") {
			return collections(schema);
		}
		if (op === "delete") {
			return [keyword("from")];
		}
		return [];
	}

	if (last.kind === "pipe") {
		return (operation ? STAGES[operation] : STAGES.select).map(keyword);
	}

	if (last.kind === "keyword") {
		return keywordContext(last.value, schema, scope);
	}

	if (last.kind === "comma") {
		// Continuation d'une liste : dépend de l'étape active depuis le dernier `|`.
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

	if (last.kind === "minus" || last.kind === "plus") {
		// Signe de direction dans `sort` : un champ suit.
		if (activeStage(toks) === "sort") {
			return fields(schema, scope, false);
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

	return [];
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
			return joinTargets(schema, scope);
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

/** Mot-clé d'étape suivant le dernier `|` (ou undefined si hors pipeline). */
function activeStage(toks: readonly Token[]): string | undefined {
	let pipeIdx = -1;
	for (let i = toks.length - 1; i >= 0; i -= 1) {
		if (toks[i]?.kind === "pipe") {
			pipeIdx = i;
			break;
		}
	}
	const stage = toks[pipeIdx + 1];
	return stage?.kind === "keyword" ? stage.value : undefined;
}

/**
 * Dans l'étape `with` active, la collection jointe (l'ident après `with`) — pour
 * compléter le membre droit de `on <local> = <foreign>`. undefined hors `with`.
 */
function onForeignCollection(toks: readonly Token[]): string | undefined {
	let pipeIdx = -1;
	for (let i = toks.length - 1; i >= 0; i -= 1) {
		if (toks[i]?.kind === "pipe") {
			pipeIdx = i;
			break;
		}
	}
	const stage = toks[pipeIdx + 1];
	if (!(stage?.kind === "keyword" && stage.value === "with")) {
		return undefined;
	}
	// On n'est en position « champ distant » que si `on` a déjà été vu.
	let sawOn = false;
	for (let i = pipeIdx + 1; i < toks.length; i += 1) {
		if (toks[i]?.kind === "keyword" && toks[i]?.value === "on") {
			sawOn = true;
		}
	}
	if (!sawOn) {
		return undefined;
	}
	const coll = toks[pipeIdx + 2];
	return coll?.kind === "ident" ? coll.value : undefined;
}

// --- Constructeurs de candidats ---------------------------------------------

function verbs(): readonly SnqlCompletion[] {
	return PRIMARY_VERBS.map((v) => ({
		label: v.label,
		type: "verb" as const,
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
