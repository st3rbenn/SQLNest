import { SnqlError } from "../diagnostics";
import type { Expr, IntrospectStatement, Stage } from "./ast";
import type { TokenCursor } from "./cursor";
import { peekIdent, peekKeyword } from "./parser-peek";
import {
	parseLimit,
	parsePick,
	parseSort,
	parseWhere,
	rejectTrailingStage
} from "./parser-select";
import { defined } from "../invariant";

/**
 * Introspection : `list …` et `describe <table>`.
 */

/**
 * `list <sub-command>` — statement d'introspection.
 * Sous-commandes : `tables`, `schemas`, `indexes [on t]`, `databases`
 * (Mongo-first), `schema_events` (SQLNest system).
 */
export function parseIntrospectList(cursor: TokenCursor): IntrospectStatement {
	const listTok = cursor.next(); // `list`
	const sub = cursor.peek();
	if (sub.kind !== "ident") {
		throw new SnqlError(
			`'list' attend une sous-commande (tables / schemas / indexes / databases / schema_events / enums), trouvé '${sub.value}'`,
			"parse_introspect_unknown_list",
			sub.span
		);
	}
	const subLower = sub.value.toLowerCase();
	if (subLower === "tables") {
		const subTok = cursor.next();
		const tail = parseIntrospectTail(cursor);
		const endSpan =
			tail.stages.length > 0
				? defined(tail.stages[tail.stages.length - 1]).span
				: subTok.span;
		return {
			operation: "introspect",
			kind: "list-tables",
			...(tail.stages.length > 0 ? { stages: tail.stages } : {}),
			span: { start: listTok.span.start, end: endSpan.end }
		};
	}
	if (subLower === "schemas") {
		const subTok = cursor.next();
		const tail = parseIntrospectTail(cursor);
		const endSpan =
			tail.stages.length > 0
				? defined(tail.stages[tail.stages.length - 1]).span
				: subTok.span;
		return {
			operation: "introspect",
			kind: "list-schemas",
			...(tail.stages.length > 0 ? { stages: tail.stages } : {}),
			span: { start: listTok.span.start, end: endSpan.end }
		};
	}
	if (subLower === "indexes") {
		const subTok = cursor.next();
		// `on <table>` optionnel — restreint aux indexes de la table cible.
		let target: string | undefined;
		let targetEnd = subTok.span.end;
		if (peekKeyword(cursor, "on")) {
			cursor.next();
			const targetTok = cursor.peek();
			if (targetTok.kind !== "ident") {
				throw new SnqlError(
					`'list indexes on' attend un nom de table, trouvé '${targetTok.value}'`,
					"parse_introspect_indexes_missing_target",
					targetTok.span
				);
			}
			cursor.next();
			target = targetTok.value;
			targetEnd = targetTok.span.end;
		}
		const tail = parseIntrospectTail(cursor);
		const endSpan =
			tail.stages.length > 0
				? defined(tail.stages[tail.stages.length - 1]).span
				: { start: targetEnd, end: targetEnd };
		return {
			operation: "introspect",
			kind: "list-indexes",
			...(target !== undefined ? { target } : {}),
			...(tail.stages.length > 0 ? { stages: tail.stages } : {}),
			span: { start: listTok.span.start, end: endSpan.end }
		};
	}
	if (subLower === "databases") {
		const subTok = cursor.next();
		const tail = parseIntrospectTail(cursor);
		const endSpan =
			tail.stages.length > 0
				? defined(tail.stages[tail.stages.length - 1]).span
				: subTok.span;
		return {
			operation: "introspect",
			kind: "list-databases",
			...(tail.stages.length > 0 ? { stages: tail.stages } : {}),
			span: { start: listTok.span.start, end: endSpan.end }
		};
	}
	if (subLower === "schema_events") {
		const subTok = cursor.next();
		const tail = parseIntrospectTail(cursor);
		const endSpan =
			tail.stages.length > 0
				? defined(tail.stages[tail.stages.length - 1]).span
				: subTok.span;
		return {
			operation: "introspect",
			kind: "list-schema-events",
			...(tail.stages.length > 0 ? { stages: tail.stages } : {}),
			span: { start: listTok.span.start, end: endSpan.end }
		};
	}
	if (subLower === "enums") {
		const subTok = cursor.next();
		const tail = parseIntrospectTail(cursor);
		const endSpan =
			tail.stages.length > 0
				? defined(tail.stages[tail.stages.length - 1]).span
				: subTok.span;
		return {
			operation: "introspect",
			kind: "list-enums",
			...(tail.stages.length > 0 ? { stages: tail.stages } : {}),
			span: { start: listTok.span.start, end: endSpan.end }
		};
	}
	throw new SnqlError(
		`'list' attend une sous-commande connue (tables / schemas / indexes / databases / schema_events / enums), trouvé '${sub.value}'`,
		"parse_introspect_unknown_list",
		sub.span
	);
}

/**
 * `describe <table>` — introspection colonnes.
 * Retourne un shape stable {name, type, nullable, default, is_primary_key,
 * foreign_key} — cohérent PG/Mongo pour que l'UI n'ait pas à brancher
 * sur l'engine.
 */
export function parseIntrospectDescribe(
	cursor: TokenCursor
): IntrospectStatement {
	const descTok = cursor.next(); // `describe`
	// `describe enum <name>` (sprint EN) — `enum` soft-ident suivi d'un 2ᵉ
	// ident. `describe enum` SEUL reste un describe-table d'une table nommée
	// `enum` (edge-case préservé, pas de breaking).
	if (peekIdent(cursor, "enum") && cursor.peek(1).kind === "ident") {
		cursor.next(); // `enum`
		const nameTok = cursor.next();
		const tail = parseIntrospectTail(cursor);
		const endSpan =
			tail.stages.length > 0
				? defined(tail.stages[tail.stages.length - 1]).span
				: nameTok.span;
		return {
			operation: "introspect",
			kind: "describe-enum",
			target: nameTok.value,
			...(tail.stages.length > 0 ? { stages: tail.stages } : {}),
			span: { start: descTok.span.start, end: endSpan.end }
		};
	}
	const target = cursor.peek();
	if (target.kind !== "ident") {
		throw new SnqlError(
			`'describe' attend un nom de table, trouvé '${target.value}'`,
			"parse_introspect_describe_missing_target",
			target.span
		);
	}
	cursor.next();
	const tail = parseIntrospectTail(cursor);
	const endSpan =
		tail.stages.length > 0
			? defined(tail.stages[tail.stages.length - 1]).span
			: target.span;
	return {
		operation: "introspect",
		kind: "describe-table",
		target: target.value,
		...(tail.stages.length > 0 ? { stages: tail.stages } : {}),
		span: { start: descTok.span.start, end: endSpan.end }
	};
}

/**
 * `for <col1>, <col2>, ...` — sucre parseur qui désucre en
 * `where name in ["col1", "col2", ...]`. Utile pour cibler des rows précises
 * d'un `describe` ou `list` sans écrire le prédicat verbeux. `for` est un
 * soft-keyword contextuel (non ajouté à KEYWORDS pour rester utilisable en
 * ident ailleurs — ex. col nommée `for`).
 */
function parseIntrospectForShortcut(cursor: TokenCursor): Stage {
	const forTok = cursor.next(); // `for`
	const names: { value: string; span: import("../lexer/token").Span }[] = [];
	for (;;) {
		const nameTok = cursor.peek();
		if (nameTok.kind !== "ident") {
			throw new SnqlError(
				`'for' attend une liste de noms de colonnes, trouvé '${nameTok.value}'`,
				"parse_introspect_for_missing_name",
				nameTok.span
			);
		}
		cursor.next();
		names.push({ value: nameTok.value, span: nameTok.span });
		if (cursor.peek().kind !== "comma") break;
		cursor.next();
	}
	const lastSpan = defined(names[names.length - 1]).span;
	const span = { start: forTok.span.start, end: lastSpan.end };
	const predicate: Expr = {
		type: "in",
		target: { type: "field", path: ["name"], span },
		values: names.map((n) => ({
			type: "literal" as const,
			value: { kind: "string" as const, value: n.value },
			span: n.span
		})),
		span
	};
	return { type: "where", predicate, span };
}

/**
 * parse la suite `where`/`pick`/`sort`/`limit` d'une commande
 * d'introspection. Ordre canonique aligné avec un `find` (parser + lower
 * réutilisent la même infra pour typecheck alias / stage order).
 *
 * Stages refusés v1 : `with`, `group`, `having` — l'introspection produit un
 * dataset autonome (pas de join possible sans schéma virtuel du shape, pas
 * d'aggregation pertinente sur 20 rows de metadata). Le rejet est explicite
 * (`parse_introspect_stage_unsupported`) pour orienter l'utilisateur.
 */
function parseIntrospectTail(cursor: TokenCursor): { stages: Stage[] } {
	const stages: Stage[] = [];
	// Refuse les stages hors périmètre AVANT de parser — sinon `describe t with`
	// consomme `with` en tentant de le parser et casse avec un message obscur.
	const unsupported = new Set(["with", "group", "having"]);
	const peekedFirst = cursor.peek();
	if (peekedFirst.kind === "keyword" && unsupported.has(peekedFirst.value)) {
		throw new SnqlError(
			`'${peekedFirst.value}' non supporté après une commande d'introspection — v1 : where / pick / sort / limit.`,
			"parse_introspect_stage_unsupported",
			peekedFirst.span
		);
	}
	// `for a, b, ...` — filter shortcut sur le nom de col/table.
	// Soft-keyword contextuel : `for` n'est jamais dans KEYWORDS (pas de
	// conflit avec les usages ident ailleurs). Ordre canonique impose
	// `for` avant `where` — s'il vient après on refuse (message dédié).
	if (
		peekedFirst.kind === "ident" &&
		peekedFirst.value.toLowerCase() === "for"
	) {
		stages.push(parseIntrospectForShortcut(cursor));
	}
	if (peekKeyword(cursor, "where")) stages.push(parseWhere(cursor));
	if (peekKeyword(cursor, "pick")) stages.push(parsePick(cursor));
	if (peekKeyword(cursor, "sort")) stages.push(parseSort(cursor));
	if (peekKeyword(cursor, "limit")) stages.push(parseLimit(cursor));
	// Un `for` post-where/pick/sort/limit = ordre violé.
	const trailing = cursor.peek();
	if (trailing.kind === "ident" && trailing.value.toLowerCase() === "for") {
		throw new SnqlError(
			"'for' doit précéder les stages classiques — écris 'describe t for a, b [where ...]'",
			"parse_introspect_for_out_of_order",
			trailing.span
		);
	}
	// Un stage encore présent après le parse dans l'ordre = ordre violé.
	rejectTrailingStage(cursor, new Set(["where", "pick", "sort", "limit"]), [
		"where",
		"pick",
		"sort",
		"limit"
	]);
	return { stages };
}
