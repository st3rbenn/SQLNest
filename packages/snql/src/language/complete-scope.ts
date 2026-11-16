import { type OperationKind, verbOperation } from "../lexer/dictionary";
import type { Token } from "../lexer/token";
import {
	getIncomingRefs,
	getOutgoingRefs,
	type SchemaModel
} from "../schema/model";
import { fieldsOf, type SnqlCompletion } from "./complete-items";

/**
 * Portée de la requête sous le curseur : table source, alias et jointures,
 * étape en cours, colonnes et navigations qu'elle rend disponibles.
 */

/** Étapes valides par opération, dans l'ordre canonique imposé par le parser. */
export const STAGES: Readonly<Record<OperationKind, readonly string[]>> = {
	select: ["with", "where", "sort", "pick", "limit"],
	update: ["where", "set"],
	delete: ["where"],
	insert: []
};

/** Suffixe d'une colonne de clé étrangère : `user_id` se navigue par `user`. */
const ID_SUFFIX = /_id$/;

/** Mots-clés de stage (utilisés pour détecter l'étape active dans un flux tokens). */
const STAGE_KEYWORDS: ReadonlySet<string> = new Set([
	"with",
	"where",
	"sort",
	"pick",
	"limit",
	"set"
]);

/**
 * Résout le membre gauche d'un `head.field` vers une collection cible : alias de
 * join explicite (scope.joins) ou nom de nav d'une FK sortante (`user` →
 * `users` via `user_id`, ADR-031 D6). Renvoie undefined si `head` n'est ni l'un
 * ni l'autre (accès JSON sur une colonne document, hors complétion schema).
 */
export function resolveDotTarget(
	head: string,
	schema: SchemaModel,
	scope: Scope
): string | undefined {
	for (const j of scope.joins) {
		if ((j.alias ?? j.collection) === head) return j.collection;
	}
	if (scope.source !== undefined) {
		for (const ref of getOutgoingRefs(schema, scope.source)) {
			if (ref.fromColumn.replace(ID_SUFFIX, "") === head) return ref.toCollection;
		}
	}
	return undefined;
}

/** Une liste de documents `[ … ` est-elle encore ouverte ? */
export function hasOpenBracket(toks: readonly Token[]): boolean {
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

// --- Portée : collection source + jointures ---------------------------------
export interface Scope {
	readonly source: string | undefined;
	readonly joins: readonly { collection: string; alias?: string }[];
}

export function operationOf(toks: readonly Token[]): OperationKind | undefined {
	const first = toks[0];
	return first?.kind === "verb" ? verbOperation(first.value) : undefined;
}

/** Extrait la collection source et les collections jointes du flux de tokens. */
export function extractScope(
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
			// `with [one|many] <coll> [as <alias>]` — skip la multiplicité optionnelle
			// (`one`/`many` sont des keywords lexés).
			let collIdx = i + 1;
			const mult = toks[collIdx];
			if (
				mult !== undefined &&
				(mult.value.toLowerCase() === "one" ||
					mult.value.toLowerCase() === "many")
			) {
				collIdx += 1;
			}
			const coll = toks[collIdx];
			if (coll?.kind === "ident") {
				const asKw = toks[collIdx + 1];
				const aliasTok = toks[collIdx + 2];
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
export function identAfter(
	toks: readonly Token[],
	kw: string
): string | undefined {
	for (let i = 0; i < toks.length; i += 1) {
		if (toks[i]?.kind === "keyword" && toks[i]?.value === kw) {
			const next = toks[i + 1];
			return next?.kind === "ident" ? next.value : undefined;
		}
	}
	return undefined;
}

/** Dernier stage keyword vu — sans pipe, on scanne à rebours le flux. */
export function activeStage(toks: readonly Token[]): string | undefined {
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
export function onForeignCollection(
	toks: readonly Token[]
): string | undefined {
	// L'introducteur du join courant est le dernier `with` OU le dernier `and`
	// en position de chaînage (les deux valides comme début d'un join).
	let introIdx = -1;
	for (let i = toks.length - 1; i >= 0; i -= 1) {
		const tok = toks[i];
		if (
			tok?.kind === "keyword" &&
			(tok.value === "with" || tok.value === "and")
		) {
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

/** Champs de la collection source (+ alias de jointure si `withAliases`). */
export function fields(
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
	out.push(...navSuggestions(schema, scope));
	return out;
}

/**
 * Forward-nav (ADR-031 D6, FK/2a) : propose les noms de nav des FK sortantes de
 * la source (`user_id` → `user`) avec `apply: "user."` prêt à driller vers la
 * colonne cible. Exclut les navs qui shadowent une colonne locale ou un alias
 * `with` déjà écrit. Le lower injecte le join implicite au `pick user.name`.
 */
function navSuggestions(
	schema: SchemaModel,
	scope: Scope
): readonly SnqlCompletion[] {
	if (scope.source === undefined) return [];
	const sourceColl = schema.collections.find((c) => c.name === scope.source);
	const localNames = new Set(sourceColl?.fields.map((f) => f.name) ?? []);
	const joinAliases = new Set(scope.joins.map((j) => j.alias ?? j.collection));
	const out: SnqlCompletion[] = [];
	const seen = new Set<string>();
	for (const ref of getOutgoingRefs(schema, scope.source)) {
		const nav = ref.fromColumn.replace(ID_SUFFIX, "");
		if (localNames.has(nav) || joinAliases.has(nav) || seen.has(nav)) continue;
		seen.add(nav);
		out.push({
			label: nav,
			type: "relation",
			detail: `→ ${ref.toCollection} (nav via ${ref.fromColumn})`,
			apply: `${nav}.`
		});
	}
	// Reverse-nav (ADR-031 D7, FK/2b) : les collections référençant la source
	// → `orders.count`. Label = fromCollection, apply `orders.` (le drill-in
	// propose `count`).
	for (const ref of getIncomingRefs(schema, scope.source)) {
		const rev = ref.fromCollection;
		if (localNames.has(rev) || joinAliases.has(rev) || seen.has(rev)) continue;
		seen.add(rev);
		out.push({
			label: rev,
			type: "relation",
			detail: `← ${rev}.count (reverse-nav via ${ref.fromColumn})`,
			apply: `${rev}.`
		});
	}
	return out;
}

/**
 * Cibles de jointure après `with` : les collections liées à la source (via une
 * relation du SchemaModel) d'abord, annotées et avec la clause `on` pré-remplie ;
 * puis les autres. Relies l'utilisateur au graphe de relations introspecté.
 */
export function joinTargets(
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
