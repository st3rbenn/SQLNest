/**
 * previewCountRewrite — transforme une source SNQL contenant un write en une
 * source SNQL équivalente qui ne fait QUE compter les rows affectées ([[ADR-023]]
 * E/4). Envoyée sur la même route `/query` que le run normal, avec le même
 * body {source} — ZÉRO backend delta ([[ADR-012]] préservé).
 *
 * ─── Cas supportés ───────────────────────────────────────────────────
 *  - `remove from t [where P]` → `find t [where P] pick count(*) as _preview_count`
 *  - `update t [as a] [with one X on l=f] [where P] set …` →
 *    `find t [as a] [with one X on l=f] [where P] pick count(*) as _preview_count`
 *  - `add (find X … pick …) into t` → `find X … pick count(*) as _preview_count` (drop le
 *    stage `pick` original, ajoute `pick count(*) as _preview_count`)
 *
 * ─── Cas non-supportés (retourne null → "aperçu indisponible") ────────
 *  - `raw` (opaque, [[ADR-019]] — D1 warn systématique mais count impossible)
 *  - `add {doc} into t` (documents literal — count trivial = nb rows, pas de
 *    roundtrip nécessaire ; le parent peut afficher `stmt.rows.length` direct)
 *  - `add {…} into t on conflict …` (upsert — imprévisible insert vs update
 *    sans exécuter réellement)
 *  - `transaction { … }` / `savepoint { … }` (multi-stmt — v1 punt)
 *  - `let x = … in <mutation>` (bindings + body, complexe à recomposer)
 *
 * ─── Extraction via .span ────────────────────────────────────────────
 * On ne re-génère PAS le SNQL depuis l'AST (pas de generator inverse dans
 * @sqlnest/snql). À la place, on extrait les sous-strings source via leur
 * Span et on recompose. Chaque construct (predicate, join, stage) porte
 * son span exact — le rewrite est donc byte-perfect pour ces sous-parties.
 */

import type {
	DeleteStatement,
	InsertStatement,
	Statement,
	UpdateStatement
} from "@sqlnest/snql";

/** Résultat d'un rewrite réussi. `note` = disclaimer optionnel D17 (join
 * implicit filtering etc.). */
export interface PreviewRewrite {
	readonly source: string;
	readonly note?: string;
}

/** Extrait une sous-chaîne de la source originale via ses offsets Span.
 * `end.offset` est exclusif (convention Span SNQL — voir token.ts). */
function extract(source: string, span: {
	readonly start: { readonly offset: number };
	readonly end: { readonly offset: number };
}): string {
	return source.slice(span.start.offset, span.end.offset);
}

/**
 * Construit une source preview `pick count(*) as _preview_count` équivalente en effet de
 * cardinalité. Retourne null pour les cas non-supportés — le caller doit
 * afficher "aperçu indisponible" plutôt que forcer un count faux.
 */
export function buildPreviewCountSource(
	source: string,
	stmt: Statement
): PreviewRewrite | null {
	switch (stmt.operation) {
		case "delete":
			return rewriteDelete(source, stmt);
		case "update":
			return rewriteUpdate(source, stmt);
		case "insert":
			return rewriteInsert(source, stmt);
		default:
			return null;
	}
}

function rewriteDelete(
	source: string,
	stmt: DeleteStatement
): PreviewRewrite {
	const parts: string[] = ["find", stmt.collection];
	if (stmt.predicate !== undefined) {
		parts.push(`where ${extract(source, stmt.predicate.span)}`);
	}
	parts.push("pick count(*) as _preview_count");
	return { source: parts.join(" ") };
}

function rewriteUpdate(
	source: string,
	stmt: UpdateStatement
): PreviewRewrite {
	const parts: string[] = ["find", stmt.collection];
	if (stmt.alias !== undefined) {
		parts.push(`as ${stmt.alias}`);
	}
	// Joins mutation T2/14 (`with one X on l=f`) : on préserve les spans
	// tels quels — le stage `with` a exactement le même shape en find qu'en
	// update, cf. UpdateStatement.joins: readonly Stage[].
	const hasJoins = stmt.joins !== undefined && stmt.joins.length > 0;
	if (hasJoins) {
		for (const join of stmt.joins ?? []) {
			parts.push(extract(source, join.span));
		}
	}
	if (stmt.predicate !== undefined) {
		parts.push(`where ${extract(source, stmt.predicate.span)}`);
	}
	parts.push("pick count(*) as _preview_count");
	return {
		source: parts.join(" "),
		// D17 disclaimer : un INNER JOIN qui ne matche pas tout drop les rows
		// sans correspondance — le count peut différer si le join a des
		// filtres implicites. Affiché sous le nombre dans WriteConfirmBar.
		note: hasJoins
			? "Count via join — peut différer si le join a des filtres implicites"
			: undefined
	};
}

function rewriteInsert(
	source: string,
	stmt: InsertStatement
): PreviewRewrite | null {
	// Documents littéraux : count trivial = nb rows tapés, mais on retourne
	// null pour laisser le caller décider (afficher stmt.rows.length inline
	// est plus rapide qu'un roundtrip — mais c'est au parent d'orchestrer).
	if (stmt.sourceQuery === undefined) return null;

	// Upsert (on conflict) — imprévisible : count SELECT source ≠ count
	// écrit (une part sera insertée, une part updatée sur conflit). Pas de
	// preview honnête.
	if (stmt.onConflict !== undefined) return null;

	// insert-select : recompose depuis sourceQuery.source + stages, en
	// remplaçant le stage `pick` par `pick count(*) as _preview_count`. Les stages non-`pick`
	// sont préservés byte-perfect via leur span.
	const sq = stmt.sourceQuery;
	const parts: string[] = ["find", sq.source.collection];
	if (sq.source.alias !== undefined) {
		parts.push(`as ${sq.source.alias}`);
	}
	const COUNT = "pick count(*) as _preview_count";
	let injected = false;
	for (const stage of sq.stages) {
		if (stage.type === "pick") {
			// Remplacement EN PLACE — préserve l'ordre grammatical `where →
			// pick → sort → limit`, sinon le rewrite produit une source
			// rejetée au parse par rejectTrailingStage.
			parts.push(COUNT);
			injected = true;
		} else {
			parts.push(extract(source, stage.span));
		}
	}
	if (!injected) parts.push(COUNT);
	return { source: parts.join(" ") };
}
