/**
 * useLiveDiagnostics — compile SNQL local debounced pendant que l'user tape.
 * Retourne le diagnostic courant (span + message + severity) ou null si la
 * query est valide ET sans écriture dangereuse.
 *
 * ─── Comportement ─────────────────────────────────────────────────────
 * - Debounce 300ms après la dernière frappe (évite le stuttering + laisse
 *   à l'user le temps de finir de taper un token).
 * - Étape 1 : parse + lower via `parse(tokenize(source))` + dispatch
 *   lower{Mutation|Transaction|Let|...}. Erreurs → severity 'error' (rouge).
 * - Étape 2 : ADR-023 E/2.3 — si le lower passe, `collectUnfilteredWrites`
 *   walk l'AST pour détecter les writes non filtrés (delete/update sans
 *   predicate racine, insert-select sans where dans sourceQuery, raw
 *   opaque, walk récursif transaction/savepoint/let). Findings → severity
 *   'warning' (amber). Un seul warning à la fois (le premier finding) —
 *   E/3 listera tous les findings dans le TextInput de confirmation.
 * - Source vide → null (rien à valider).
 * - Erreurs "obviously incomplete" (source trop courte, se termine par un
 *   opérateur/comma) → null (bruit pendant la frappe). Le guard s'applique
 *   AUSSI au check unfiltered (D11) pour éviter les squigglies pendant
 *   qu'on tape `remove from users wh…`.
 *
 * ─── Sécurité ────────────────────────────────────────────────────────
 * Le compile est CÔTÉ CLIENT — aucune requête réseau, aucun accès DB.
 * Le schema utilisé est celui déjà chargé pour l'autocomplete (SchemaModel
 * en mémoire, provenance CLI). Zero surface d'attaque.
 */

import {
	capabilitiesFor,
	lower,
	lowerIntrospect,
	lowerLet,
	lowerMutation,
	lowerRaw,
	lowerTransaction,
	parse,
	type SchemaModel,
	SnqlError,
	type Statement,
	tokenize
} from "@sqlnest/snql";
import { useEffect, useState } from "react";
import type { LiveDiagnostic } from "./errorMarkers";
import {
	collectUnfilteredWrites,
	labelForFinding,
	type UnfilteredFinding
} from "./unfilteredWrites";
import type { SerializedSpan } from "./useRunQuery";

/** Délai d'inactivité avant de re-compiler. Trade-off réactivité vs bruit. */
const DEBOUNCE_MS = 300;

/** Résultat du hook — LiveDiagnostic (squiggly warn/error éphémère) + span
 * du RawStatement racine s'il existe (décoration permanente D1 dans
 * l'éditeur, séparée de la squiggly car elle reste visible tant que la
 * source est raw). */
export interface LiveDiagnosticsResult {
	readonly diag: LiveDiagnostic | null;
	readonly rawStatementSpan: SerializedSpan | null;
}

/**
 * Retourne le diagnostic live courant + le span d'un RawStatement éventuel.
 * Recalcule debounced à chaque changement de source/schema/engine.
 */
export function useLiveDiagnostics(
	source: string,
	engine: string,
	schema: SchemaModel | undefined
): LiveDiagnosticsResult {
	const [state, setState] = useState<LiveDiagnosticsResult>({
		diag: null,
		rawStatementSpan: null
	});

	useEffect(() => {
		if (isObviouslyIncomplete(source)) {
			setState({ diag: null, rawStatementSpan: null });
			return;
		}
		const handle = setTimeout(() => {
			try {
				const statement = parse(tokenize(source));
				// [ADR-023 D1 / E/7.4] Décoration Raw permanente : dès qu'on
				// détecte operation === 'raw', extract le span pour render
				// le gutter icon "unsafe" (indépendant du live diag warn qui
				// peut être overwrite par une squiggly unfiltered plus loin).
				const rawStatementSpan: SerializedSpan | null =
					statement.operation === "raw"
						? [
								statement.span.start.offset,
								statement.span.end.offset - statement.span.start.offset
							]
						: null;
				// Étape 1 : lower schema-aware (parse/lower/plan errors).
				validateStatement(statement, engine, schema);
				// Étape 2 (ADR-023 E/2.3) : détection unfiltered writes après
				// lower réussi. La détection ne s'applique QUE sur source
				// syntaxiquement + sémantiquement valide — évite les warnings
				// parasites pendant qu'on tape (D11 guard isObviouslyIncomplete
				// déjà appliqué en amont ; le lower success confirme que la
				// source est complète et cohérente).
				const findings = collectUnfilteredWrites(statement);
				if (findings.length > 0) {
					setState({
						diag: findingToDiagnostic(findings[0]!, findings.length),
						rawStatementSpan
					});
					return;
				}
				setState({ diag: null, rawStatementSpan });
			} catch (err) {
				let diag: LiveDiagnostic | null = null;
				if (err instanceof SnqlError && err.span !== undefined) {
					const span: SerializedSpan = [
						err.span.start.offset,
						err.span.end.offset - err.span.start.offset
					];
					diag = { span, message: err.message, severity: "error" };
				}
				// Erreur sans span (rare : plan sans traçabilité) → diag null,
				// pas de tooltip orphelin. Le raw span reste null aussi car
				// l'AST n'est pas valide — on n'a pas de statement à consulter.
				setState({ diag, rawStatementSpan: null });
			}
		}, DEBOUNCE_MS);
		return () => clearTimeout(handle);
	}, [source, engine, schema]);

	return state;
}

/**
 * Valide un statement SNQL déjà parsé sans produire de native — dispatch selon
 * operation. `compile()` était read-only (throw sur mutation) : le live diag
 * était donc SILENCIEUX sur add/update/remove/upsert/transaction, exactement
 * les cas les plus enclins à des typos (keys de doc, cols de where). Ici on
 * rejoue le bon lower pour chaque type — les erreurs typées SNQL (span porté)
 * remontent telles quelles et déclenchent la squiggly + tooltip.
 *
 * Le statement est passé en argument (déjà parsé) plutôt que la source string
 * — évite un double parse quand le walker unfiltered (ADR-023 E/2.3) tourne
 * sur le même statement dans la foulée.
 */
function validateStatement(
	statement: Statement,
	engine: string,
	schema: SchemaModel | undefined
): void {
	switch (statement.operation) {
		case "select":
			lower(statement, schema);
			return;
		case "insert":
		case "update":
		case "delete":
			lowerMutation(statement, schema);
			return;
		case "transaction":
			lowerTransaction(statement, schema);
			return;
		case "introspect":
			lowerIntrospect(statement, schema);
			return;
		case "raw":
			lowerRaw(statement);
			return;
		case "let":
			lowerLet(statement, schema);
			return;
		case "savepoint":
			// Standalone `savepoint` (hors transaction) n'est pas exécutable —
			// mais le parser l'accepte comme statement. Rien à valider ici.
			return;
	}
	// Défense : capability check symbolique pour un engine inconnu (au cas où
	// on route sur un mauvais moteur — refuse au niveau live diag avec un
	// message actionable).
	if (capabilitiesFor(engine) === undefined) {
		throw new SnqlError(`Moteur inconnu '${engine}'`, "unknown_engine");
	}
}

/**
 * Convertit un finding "unfiltered write" en LiveDiagnostic warning. Suffixe
 * `(1/N)` quand plusieurs findings coexistent pour signaler que d'autres
 * suivent — E/3 les listera tous dans la surface confirmation.
 */
function findingToDiagnostic(
	finding: UnfilteredFinding,
	total: number
): LiveDiagnostic {
	const span: SerializedSpan = [
		finding.span.start.offset,
		finding.span.end.offset - finding.span.start.offset
	];
	const suffix = total > 1 ? ` (1/${total})` : "";
	return {
		span,
		message: labelForFinding(finding) + suffix,
		severity: "warning"
	};
}

/**
 * Heuristique : source trop courte OU se terminant par un token qui suggère
 * frappe en cours (opérateur, comma, `.`). Suppress le diagnostic pendant
 * que l'user finit de taper — évite les faux positifs "verbe manquant" sur
 * `find u wh` etc.
 */
function isObviouslyIncomplete(source: string): boolean {
	const trimmed = source.trim();
	if (trimmed.length === 0) return true;
	// Se termine par un token d'attente : opérateur binaire, comma, dot.
	const last = trimmed.charAt(trimmed.length - 1);
	if (last === "," || last === "." || last === "=" || last === "<" || last === ">") return true;
	// Se termine par `and`/`or`/`in`/`like`/`not` — attend un opérande.
	if (/(\s|^)(and|or|not|in|like|by|as|on)\s*$/i.test(trimmed)) return true;
	return false;
}
