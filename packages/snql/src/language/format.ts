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
	const parts: string[] = [];

	for (let i = 0; i < toks.length; i += 1) {
		const tok = toks[i] as Token;
		const isStage = tok.kind === "keyword" && STAGE_KEYWORDS.has(tok.value);
		const isChainAnd =
			tok.kind === "keyword" && tok.value === "and" && chainingAnds.has(i);

		if (isStage && parts.length > 0) {
			parts.push(`\n${STAGE_INDENT}${tok.value}`);
			continue;
		}
		if (isChainAnd) {
			parts.push(`\n${AND_INDENT}and`);
			continue;
		}
		if (parts.length > 0) {
			const prev = toks[i - 1] as Token;
			if (needsSpaceBefore(prev, tok)) {
				parts.push(" ");
			}
		}
		parts.push(renderToken(tok));
	}
	return parts.join("");
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
	if (
		prev.kind === "lparen" ||
		prev.kind === "lbracket" ||
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
