/**
 * Formatter SNQL — token-based. Met chaque étape sur sa propre ligne et
 * aligne les `and` de chaînage de `with`. Best-effort : renvoie la source
 * telle quelle si elle n'est pas tokenisable, pour ne jamais bloquer la
 * frappe de l'utilisateur.
 */

import { tokenize } from "../lexer/lexer";
import type { Token } from "../lexer/token";

const STAGE_KEYWORDS: ReadonlySet<string> = new Set([
	"with",
	"where",
	"group",
	"having",
	"sort",
	"pick",
	"limit",
	"set",
	"into"
]);

const STAGE_INDENT = "  ";
const AND_INDENT = "   ";
// Indent des items d'un `pick`/`sort`/`set` multi-ligne. 4 spaces = 2× stage,
// style block SQL classique — prévisible quelle que soit la longueur du 1er item.
const ITEM_INDENT = "    ";
// Un pick/sort/set devient multi-ligne à partir de N items (compter les virgules
// TOP-LEVEL — celles imbriquées dans un call ou un [] ne comptent pas).
const MULTILINE_MIN_ITEMS = 3;
// Sprint T2/15 : indent d'un niveau de container statement (transaction /
// savepoint). Chaque niveau ajoute STAGE_INDENT (2 spaces) au préfixe.
const CONTAINER_STEP = "  ";

/** Formate une source SNQL avec sauts de ligne canoniques (par étape). */
export function formatSnql(source: string): string {
	let raw: Token[];
	try {
		raw = tokenize(source);
	} catch {
		return source;
	}
	const toks = raw.filter((t) => t.kind !== "eof");
	if (toks.length === 0) {
		return "";
	}
	const chainingAnds = markChainingAnds(toks);
	// Post-format-audit — les stages ne doivent PAS se splitter en newline
	// quand ils apparaissent intra-parens (sub-query `(find … pick …)`,
	// `over (partition … sort …)`, `string_agg(… sort …)`) ou dans l'action
	// d'un `on conflict (…) edit set … [where …]`. inlineStages[i] = true
	// signale au walker principal de traiter le stage keyword comme un token
	// regular (sans newline+indent).
	const inlineStages = markInlineStages(toks);
	const { splitCommas, multilineStages } = markMultiline(toks, inlineStages);
	// Sprint object-literals — marker les {…} / […] multi-ligne (≥ 3 items).
	// Ajoute aux splitCommas les commas internes du bloc + retourne les
	// openers/closers pour insérer newline+indent block-style.
	const { blockOpeners, blockClosers } = markBlockLiterals(
		toks,
		splitCommas,
		multilineStages
	);
	// Sprint T2/15 — marker les blocs `transaction { … }` / `savepoint <name>
	// { … }`. Ces containers indentent leurs stmts enfants + split sur `;`.
	// containerDepthAt[i] = profondeur au token i (0 = top-level, 1 = dans un
	// transaction ou savepoint, 2 = savepoint nested dans transaction).
	const {
		containerOpeners,
		containerClosers,
		containerSemicolons,
		containerDepthAt
	} = markStatementContainers(toks);

	const parts: string[] = [];
	// Set après avoir émis un `\n<indent>` (soit newline de stage/and/comma-split,
	// soit newline d'item après un keyword stage multi-ligne). Bypasse la logique
	// needsSpaceBefore une fois : on ne veut pas d'espace en plus après un indent.
	let pendingItemNewline = false;
	let suppressNextSpace = false;

	for (let i = 0; i < toks.length; i += 1) {
		const tok = toks[i] as Token;
		const isStage = tok.kind === "keyword" && STAGE_KEYWORDS.has(tok.value);
		const isChainAnd =
			tok.kind === "keyword" && tok.value === "and" && chainingAnds.has(i);
		const splitIndent = splitCommas.get(i);
		const blockOpenIndent = blockOpeners.get(i);
		const blockCloseIndent = blockClosers.get(i);
		const containerOpenIndent = containerOpeners.get(i);
		const containerCloseIndent = containerClosers.get(i);
		const containerSemicolonIndent = containerSemicolons.get(i);
		// Sprint T2/15 : offset d'indent additionnel pour stages/ands quand
		// on est dans un container (transaction/savepoint). Depth 0 = pas
		// d'offset (top-level), depth ≥ 1 = CONTAINER_STEP × depth spaces.
		const containerDepth = containerDepthAt[i] ?? 0;
		const containerOffset = CONTAINER_STEP.repeat(containerDepth);

		if (isStage && parts.length > 0 && !inlineStages.has(i)) {
			parts.push(`\n${containerOffset}${STAGE_INDENT}${tok.value}`);
			pendingItemNewline = multilineStages.has(i);
			continue;
		}
		if (isChainAnd) {
			parts.push(`\n${containerOffset}${AND_INDENT}and`);
			continue;
		}
		if (splitIndent !== undefined) {
			// Virgule top-level d'un pick/sort/set OU d'un object/array literal
			// multi-ligne : virgule collée à l'item précédent, puis newline + indent.
			parts.push(`,\n${containerOffset}${splitIndent}`);
			suppressNextSpace = true;
			continue;
		}
		if (containerSemicolonIndent !== undefined) {
			// Sprint T2/15 : `;` intra-transaction — collé au stmt précédent,
			// puis newline + indent container (le stmt suivant démarre à cet indent).
			parts.push(`;\n${containerSemicolonIndent}`);
			suppressNextSpace = true;
			continue;
		}
		if (tok.kind === "semicolon" && containerDepth === 0) {
			// Sprint T3/6 : `;` top-level d'un CTE `let x = …; let y = …; body`
			// — colle le `;` au stmt précédent, puis newline sans indent (le
			// prochain `let`/body démarre en tête de ligne).
			parts.push(";\n");
			suppressNextSpace = true;
			continue;
		}
		if (containerCloseIndent !== undefined) {
			// Sprint T2/15 : `}` d'un container — newline + indent parent avant.
			parts.push(`\n${containerCloseIndent}${tok.value}`);
			continue;
		}
		if (blockCloseIndent !== undefined) {
			// `}` ou `]` d'un bloc multi-ligne : newline+indent parent avant le closer.
			parts.push(`\n${blockCloseIndent}${tok.value}`);
			continue;
		}
		if (parts.length > 0) {
			if (pendingItemNewline) {
				parts.push(`\n${containerOffset}${ITEM_INDENT}`);
				pendingItemNewline = false;
				suppressNextSpace = true;
			}
			if (suppressNextSpace) {
				suppressNextSpace = false;
			} else {
				const prev = toks[i - 1] as Token;
				if (needsSpaceBefore(prev, tok)) {
					parts.push(" ");
				}
			}
		}
		parts.push(renderToken(tok));
		if (containerOpenIndent !== undefined) {
			// Sprint T2/15 : `{` d'un container — newline + indent child après.
			parts.push(`\n${containerOpenIndent}`);
			suppressNextSpace = true;
		} else if (blockOpenIndent !== undefined) {
			// `{` ou `[` d'un bloc multi-ligne : émettre newline+indent enfant
			// APRÈS l'opener, avant le premier item.
			parts.push(`\n${blockOpenIndent}`);
			suppressNextSpace = true;
		}
	}
	return parts.join("");
}

/**
 * Repère les stages `pick` / `sort` / `set` qui doivent passer en multi-ligne
 * (compter les virgules TOP-LEVEL de ce stage — celles imbriquées dans un call
 * `f(a, b)` ou une liste `in [a, b]` restent inline).
 *
 * Retourne :
 *  - `splitCommas` : Map `index de virgule → indent block` pour chaque virgule
 *    à convertir en newline+indent
 *  - `multilineStages` : Set des index des keywords stage (pick/sort/set) dont
 *    le premier item doit aussi passer à la ligne (style block cohérent).
 */
function markMultiline(
	toks: readonly Token[],
	inlineStages: ReadonlySet<number>
): {
	splitCommas: Map<number, string>;
	multilineStages: ReadonlySet<number>;
} {
	const splitCommas = new Map<number, string>();
	const multilineStages = new Set<number>();
	let i = 0;
	while (i < toks.length) {
		const tok = toks[i] as Token;
		if (
			tok.kind !== "keyword" ||
			(tok.value !== "pick" && tok.value !== "sort" && tok.value !== "set" && tok.value !== "group") ||
			// Stage inline (intra-parens / on-conflict action) — n'entre pas en
			// mode multi-ligne : ses items restent inline avec le contexte.
			inlineStages.has(i)
		) {
			i += 1;
			continue;
		}
		// Scanner les virgules top-level de ce stage jusqu'au prochain stage ou eof.
		const topLevelCommas: number[] = [];
		let depth = 0;
		let j = i + 1;
		while (j < toks.length) {
			const t = toks[j] as Token;
			if (
				t.kind === "keyword" &&
				STAGE_KEYWORDS.has(t.value) &&
				depth === 0
			) {
				break;
			}
			if (t.kind === "lparen" || t.kind === "lbracket" || t.kind === "lbrace") {
				depth += 1;
			} else if (t.kind === "rparen" || t.kind === "rbracket" || t.kind === "rbrace") {
				depth -= 1;
			} else if (t.kind === "comma" && depth === 0) {
				topLevelCommas.push(j);
			}
			j += 1;
		}
		// Nombre d'items = commas + 1. Split seulement si assez d'items.
		if (topLevelCommas.length + 1 >= MULTILINE_MIN_ITEMS) {
			multilineStages.add(i);
			for (const commaIdx of topLevelCommas) {
				splitCommas.set(commaIdx, ITEM_INDENT);
			}
		}
		i = j;
	}
	return { splitCommas, multilineStages };
}

/**
 * Sprint object-literals — repère les `{…}` / `[…]` multi-ligne (≥ 3 items
 * top-level de ce bloc). Retourne :
 *  - `blockOpeners` : Map `index de `{` ou `[` → childIndent` (à émettre
 *    APRÈS l'opener sous forme `\n<indent>`, pour le premier item).
 *  - `blockClosers` : Map `index de `}` ou `]` → parentIndent` (à émettre
 *    AVANT le closer sous forme `\n<indent>`).
 *  - Effet de bord : les commas top-level de chaque bloc multi-ligne sont
 *    ajoutés à `splitCommas` (in-place) avec le childIndent adapté.
 *
 * Depth counter : chaque niveau d'imbrication ajoute `ITEM_INDENT` (4 spaces).
 * Le bloc top-level est à profondeur 1 (contenu = 4 spaces, closer = 0). Un
 * bloc nested dans un autre bloc est à profondeur parent+1.
 */
function markBlockLiterals(
	toks: readonly Token[],
	splitCommas: Map<number, string>,
	multilineStages: ReadonlySet<number>
): {
	blockOpeners: Map<number, string>;
	blockClosers: Map<number, string>;
} {
	const blockOpeners = new Map<number, string>();
	const blockClosers = new Map<number, string>();

	interface Frame {
		readonly openerIdx: number;
		readonly depth: number; // profondeur du contenu du bloc (childIndent = ITEM_INDENT × depth)
		readonly commas: number[];
	}
	const stack: Frame[] = [];
	// Track si on est actuellement dans les items d'un stage pick/sort/set
	// multi-ligne — dans ce cas, l'opener `{`/`[` d'un bloc top-level est déjà
	// à ITEM_INDENT, donc son contenu doit s'indenter à ITEM_INDENT × 2.
	let inMultilineStage = false;

	for (let i = 0; i < toks.length; i += 1) {
		const tok = toks[i] as Token;
		if (tok.kind === "keyword" && STAGE_KEYWORDS.has(tok.value)) {
			inMultilineStage = multilineStages.has(i);
			continue;
		}
		if (tok.kind === "lbrace" || tok.kind === "lbracket") {
			// Depth du contenu = depth du parent + 1. Sans parent : 1 seul si
			// pas dans un stage multi-ligne, sinon 2 (car opener déjà à indent 1).
			const parentDepth =
				stack.length > 0
					? (stack[stack.length - 1] as Frame).depth
					: inMultilineStage
						? 1
						: 0;
			stack.push({ openerIdx: i, depth: parentDepth + 1, commas: [] });
		} else if (tok.kind === "rbrace" || tok.kind === "rbracket") {
			const frame = stack.pop();
			if (frame === undefined) continue;
			// Multi-ligne si ≥ MULTILINE_MIN_ITEMS items (items = commas + 1).
			// Empty `{}` / `[]` (0 comma, 0 item) reste inline.
			const itemCount = frame.commas.length + 1;
			if (itemCount < MULTILINE_MIN_ITEMS) continue;
			const childIndent = ITEM_INDENT.repeat(frame.depth);
			// Closer aligné : depth > 1 → parent bloc (ITEM_INDENT × depth-1),
			// depth == 1 → parent stage (STAGE_INDENT, aligné avec le keyword).
			const parentIndent =
				frame.depth > 1 ? ITEM_INDENT.repeat(frame.depth - 1) : STAGE_INDENT;
			blockOpeners.set(frame.openerIdx, childIndent);
			blockClosers.set(i, parentIndent);
			for (const commaIdx of frame.commas) {
				splitCommas.set(commaIdx, childIndent);
			}
		} else if (tok.kind === "comma" && stack.length > 0) {
			(stack[stack.length - 1] as Frame).commas.push(i);
		}
	}

	return { blockOpeners, blockClosers };
}

/**
 * Post-format-audit : marque les stage keywords qui doivent rester inline
 * (pas de `\n<indent>stage` split). Deux cas :
 *
 *  1. **Intra-parens** — quand `sort`/`pick`/`where`/`set` apparaît dans un
 *     `(…)` (sub-query `(find … pick …)`, `over (partition … sort …)`,
 *     `string_agg(… sort …)`), il fait partie de l'expression courante et
 *     ne doit pas casser la ligne.
 *
 *  2. **On-conflict action** — dans `add {…} into t on conflict (…) edit
 *     set … [where …]`, les `set` et `where` appartiennent à l'action
 *     `edit` et restent inline. `pick count` post-action se resplit
 *     normalement.
 */
function markInlineStages(toks: readonly Token[]): ReadonlySet<number> {
	const out = new Set<number>();
	let parenDepth = 0;
	// State machine on-conflict :
	//   idle → seen-on → seen-on-conflict → expecting-edit → in-action
	// Retour à idle sur : `;` / `}` / `pick` (top-level) / EOF, ou si la
	// séquence attendue est cassée (`ignore` au lieu de `edit` par ex.).
	type Phase = "idle" | "seen-on" | "seen-on-conflict" | "expecting-edit" | "in-action";
	let phase: Phase = "idle";
	for (let i = 0; i < toks.length; i += 1) {
		const tok = toks[i] as Token;

		// Exit de l'action on-conflict à un breakpoint top-level.
		if (phase === "in-action" && parenDepth === 0) {
			if (
				tok.kind === "semicolon" ||
				tok.kind === "rbrace" ||
				(tok.kind === "keyword" && tok.value === "pick")
			) {
				phase = "idle";
			}
		}

		// State machine progression.
		if (phase === "idle" && tok.kind === "keyword" && tok.value === "on") {
			phase = "seen-on";
		} else if (phase === "seen-on") {
			if (tok.kind === "keyword" && tok.value === "conflict") {
				phase = "seen-on-conflict";
			} else {
				phase = "idle";
			}
		} else if (
			phase === "seen-on-conflict" &&
			tok.kind === "rparen" &&
			parenDepth === 1
		) {
			// Sort de `(col1, col2)` — attend l'action `edit` ou `ignore`.
			phase = "expecting-edit";
		} else if (phase === "expecting-edit") {
			if (tok.kind === "verb" && tok.value === "edit") {
				phase = "in-action";
			} else if (!(tok.kind === "rparen" || tok.kind === "lparen")) {
				// `ignore` ou autre chose que `edit` — pas d'action inline.
				phase = "idle";
			}
		}

		// Cas 1 : stage intra-parens → inline.
		if (
			parenDepth > 0 &&
			tok.kind === "keyword" &&
			(tok.value === "sort" ||
				tok.value === "pick" ||
				tok.value === "where" ||
				tok.value === "set" ||
				tok.value === "limit" ||
				tok.value === "group" ||
				tok.value === "having")
		) {
			out.add(i);
		}
		// Cas 2 : `set` / `where` intra-action on-conflict → inline.
		if (
			phase === "in-action" &&
			parenDepth === 0 &&
			tok.kind === "keyword" &&
			(tok.value === "set" || tok.value === "where")
		) {
			out.add(i);
		}

		if (tok.kind === "lparen") parenDepth += 1;
		else if (tok.kind === "rparen") parenDepth -= 1;
	}
	return out;
}

/**
 * Sprint T2/15 : détecte les blocs `transaction { … }` et `savepoint <name>
 * { … }`. Ces containers indentent leurs stmts enfants (childIndent =
 * CONTAINER_STEP × depth) et splittent sur `;` (chaque stmt sur sa ligne).
 * `depth` compte le nesting (savepoint dans transaction = depth 2).
 *
 * Retourne :
 *  - `containerOpeners[openerIdx]` = childIndent à émettre après `{`
 *  - `containerClosers[closerIdx]` = parentIndent à émettre avant `}`
 *  - `containerSemicolons[semicolonIdx]` = childIndent pour split après `;`
 *  - `containerDepthAt[i]` = profondeur containers ouverts à la position i
 */
function markStatementContainers(toks: readonly Token[]): {
	containerOpeners: Map<number, string>;
	containerClosers: Map<number, string>;
	containerSemicolons: Map<number, string>;
	containerDepthAt: readonly number[];
} {
	const containerOpeners = new Map<number, string>();
	const containerClosers = new Map<number, string>();
	const containerSemicolons = new Map<number, string>();
	const containerDepthAt: number[] = new Array(toks.length).fill(0);

	interface ContainerFrame {
		readonly openerIdx: number;
		readonly depth: number; // 1-indexed (première ouverture = 1)
		readonly childIndent: string;
		readonly parentIndent: string;
	}
	const stack: ContainerFrame[] = [];

	// Pattern detection : le `{` qui suit `transaction [isolation …]` ou
	// `savepoint <ident>` ouvre un statement container. Toute autre `{` est
	// un object literal (géré par markBlockLiterals).
	let expectingContainerBrace = false;

	for (let i = 0; i < toks.length; i += 1) {
		const tok = toks[i] as Token;
		containerDepthAt[i] = stack.length;

		if (tok.kind === "keyword" && (tok.value === "transaction" || tok.value === "savepoint")) {
			expectingContainerBrace = true;
			continue;
		}
		if (tok.kind === "lbrace" && expectingContainerBrace) {
			const depth = stack.length + 1;
			const childIndent = CONTAINER_STEP.repeat(depth);
			const parentIndent = CONTAINER_STEP.repeat(depth - 1);
			stack.push({ openerIdx: i, depth, childIndent, parentIndent });
			containerOpeners.set(i, childIndent);
			expectingContainerBrace = false;
			// L'opener lui-même est encore à parent depth ; le contenu à depth++.
			// containerDepthAt[i] déjà = ancien depth (avant push). OK.
			containerDepthAt[i] = depth; // le token `{` est au niveau parent, mais
			// on l'annote au niveau enfant pour cohérence (aucun effet sur l'output
			// car `{` ne déclenche pas de stage/comma path).
			continue;
		}
		if (tok.kind === "rbrace" && stack.length > 0) {
			// Vérifier que ce `}` est bien le closer d'un container (pas d'un
			// object literal nested). Le container au sommet du stack a un
			// openerIdx ; si toutes les lbrace/rbrace intermédiaires balancent,
			// on ferme le container. Simplification : le stack ne contient que
			// des containers (les object literals sont traités séparément par
			// markBlockLiterals). Mais un object literal `{a:1}` interne va
			// aussi émettre lbrace/rbrace qu'on doit skipper.
			//
			// Heuristique : on ne pop qu'à profondeur brace globale balancée.
			// Approche plus simple : compter le nesting brace depuis openerIdx
			// et pop quand `}` correspondant.
			const top = stack[stack.length - 1] as ContainerFrame;
			if (bracesBalanceBetween(toks, top.openerIdx + 1, i)) {
				stack.pop();
				containerClosers.set(i, top.parentIndent);
			}
			// Sinon : `}` d'un object literal nested — ne rien faire ici,
			// markBlockLiterals s'en occupe.
			continue;
		}
		if (tok.kind === "semicolon" && stack.length > 0) {
			// `;` intra-container top-level (pas dans un sub-block). Le split
			// utilise le childIndent du container immédiatement englobant.
			const top = stack[stack.length - 1] as ContainerFrame;
			containerSemicolons.set(i, top.childIndent);
			continue;
		}
		// Toute autre keyword réinitialise l'attente de container brace
		// (ex : `transaction isolation serializable` — les 2 keywords isolation
		// et serializable ne doivent pas cancel, mais `find` derrière `{` ne
		// pas cancel non plus). Simplification : cancel seulement sur lbrace
		// consommée sans être container, ce qui n'arrive pas en pratique.
	}

	return { containerOpeners, containerClosers, containerSemicolons, containerDepthAt };
}

/**
 * Vrai si les braces `{` / `}` entre [from, to) (exclusif `to`) balancent
 * globalement. Utilisé pour vérifier que `toks[to]` (un `}`) ferme bien le
 * container ouvert en `openerIdx = from - 1`, sans que des object literals
 * internes viennent perturber le compte.
 */
function bracesBalanceBetween(toks: readonly Token[], from: number, to: number): boolean {
	let balance = 0;
	for (let i = from; i < to; i += 1) {
		const t = toks[i] as Token;
		if (t.kind === "lbrace") balance += 1;
		else if (t.kind === "rbrace") balance -= 1;
	}
	return balance === 0;
}

/**
 * Marque les positions des `and` qui chaînent un join (`with X on … = … and`)
 * — à distinguer des `and` booléens dans un prédicat où le retour à la ligne
 * casserait la lisibilité.
 */
function markChainingAnds(toks: readonly Token[]): ReadonlySet<number> {
	const result = new Set<number>();
	let inWith = false;
	let sawOn = false;
	let sawEq = false;
	for (let i = 0; i < toks.length; i += 1) {
		const tok = toks[i] as Token;
		if (tok.kind === "keyword") {
			if (tok.value === "with") {
				inWith = true;
				sawOn = false;
				sawEq = false;
			} else if (inWith && tok.value === "on") {
				sawOn = true;
				sawEq = false;
			} else if (inWith && tok.value === "and" && sawOn && sawEq) {
				result.add(i);
				sawOn = false;
				sawEq = false;
			} else if (STAGE_KEYWORDS.has(tok.value) && tok.value !== "with") {
				inWith = false;
			}
		} else if (inWith && sawOn && tok.kind === "op" && tok.value === "=") {
			sawEq = true;
		}
	}
	return result;
}

function needsSpaceBefore(prev: Token, curr: Token): boolean {
	if (
		curr.kind === "comma" ||
		curr.kind === "dot" ||
		curr.kind === "colon" ||
		curr.kind === "rparen" ||
		curr.kind === "rbracket" ||
		curr.kind === "rbrace"
	) {
		return false;
	}
	// Appel de fonction : `upper(` ou `now(` — pas d'espace entre le nom de la
	// fonction et sa parenthèse ouvrante. Un chemin `x.y(` reste callé aussi.
	if (curr.kind === "lparen" && prev.kind === "ident") {
		return false;
	}
	if (
		prev.kind === "lparen" ||
		prev.kind === "lbracket" ||
		prev.kind === "lbrace" ||
		prev.kind === "dot"
	) {
		return false;
	}
	return true;
}

function renderToken(tok: Token): string {
	if (tok.kind === "string") {
		return `"${tok.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return tok.value;
}
