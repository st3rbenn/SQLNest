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
	const { splitCommas, multilineStages } = markMultiline(toks);
	// Sprint object-literals — marker les {…} / […] multi-ligne (≥ 3 items).
	// Ajoute aux splitCommas les commas internes du bloc + retourne les
	// openers/closers pour insérer newline+indent block-style.
	const { blockOpeners, blockClosers } = markBlockLiterals(
		toks,
		splitCommas,
		multilineStages
	);
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

		if (isStage && parts.length > 0) {
			parts.push(`\n${STAGE_INDENT}${tok.value}`);
			pendingItemNewline = multilineStages.has(i);
			continue;
		}
		if (isChainAnd) {
			parts.push(`\n${AND_INDENT}and`);
			continue;
		}
		if (splitIndent !== undefined) {
			// Virgule top-level d'un pick/sort/set OU d'un object/array literal
			// multi-ligne : virgule collée à l'item précédent, puis newline + indent.
			parts.push(`,\n${splitIndent}`);
			suppressNextSpace = true;
			continue;
		}
		if (blockCloseIndent !== undefined) {
			// `}` ou `]` d'un bloc multi-ligne : newline+indent parent avant le closer.
			parts.push(`\n${blockCloseIndent}${tok.value}`);
			continue;
		}
		if (parts.length > 0) {
			if (pendingItemNewline) {
				parts.push(`\n${ITEM_INDENT}`);
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
		if (blockOpenIndent !== undefined) {
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
function markMultiline(toks: readonly Token[]): {
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
			(tok.value !== "pick" && tok.value !== "sort" && tok.value !== "set")
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
