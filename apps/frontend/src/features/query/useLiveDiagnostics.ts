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
 * - Étape 2 : si le lower passe, `collectUnfilteredWrites` walk l'AST
 *   pour détecter les writes non filtrés (delete/update sans predicate
 *   racine, insert-select sans where dans sourceQuery, raw opaque, walk
 *   récursif transaction/savepoint/let). Findings → severity 'warning'
 *   (amber). Un seul warning à la fois (le premier finding) — les autres
 *   sont listés dans la surface confirmation.
 * - Source vide → null (rien à valider).
 * - Erreurs "obviously incomplete" (source trop courte, se termine par un
 *   opérateur/comma) → null (bruit pendant la frappe). Le guard s'applique
 *   AUSSI au check unfiltered pour éviter les squigglies pendant qu'on
 *   tape `remove from users wh…`.
 *
 * ─── Sécurité ────────────────────────────────────────────────────────
 * Le compile est CÔTÉ CLIENT — aucune requête réseau, aucun accès DB.
 * Le schema utilisé est celui déjà chargé pour l'autocomplete (SchemaModel
 * en mémoire, provenance CLI). Zero surface d'attaque.
 */

import {
	assertDDLSupported,
	assertIntrospectSupported,
	assertLetSupported,
	assertMongoMutationWriteCastCoercive,
	assertMutationCastTargetsSupported,
	assertMutationInsertSelectSupported,
	assertMutationUpsertSupported,
	assertMutationWriteJoinSupported,
	assertTransactionSupported,
	capabilitiesFor,
	getMapper,
	lower,
	lowerDDL,
	lowerIntrospect,
	lowerLet,
	lowerMutation,
	lowerRaw,
	lowerTransaction,
	mapKvDDL,
	parse,
	plan as planLogical,
	type SchemaModel,
	SnqlError,
	type Statement,
	tokenize
} from "@sqlnest/snql";
import { useEffect, useState } from "react";
import type { LiveDiagnostic } from "./errorMarkers";
import {
	collectDivergenceHints,
	type DivergenceHint
} from "./divergenceHints";
import { collectPerfHints, type PerfHint } from "./perfHints";
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
				// Décoration Raw permanente : dès qu'on détecte
				// operation === 'raw', extract le span pour render le gutter
				// icon "unsafe" (indépendant du live diag warn qui peut être
				// overwrite par une squiggly unfiltered plus loin).
				const rawStatementSpan: SerializedSpan | null =
					statement.operation === "raw"
						? [
								statement.span.start.offset,
								statement.span.end.offset - statement.span.start.offset
							]
						: null;
				// Étape 1 : lower schema-aware (parse/lower/plan errors).
				validateStatement(statement, engine, schema);
				// Étape 2 : détection unfiltered writes après lower réussi.
				// La détection ne s'applique QUE sur source syntaxiquement +
				// sémantiquement valide — évite les warnings parasites pendant
				// qu'on tape (guard isObviouslyIncomplete déjà appliqué en
				// amont ; le lower success confirme que la source est complète
				// et cohérente).
				const findings = collectUnfilteredWrites(statement);
				if (findings.length > 0) {
					setState({
						diag: findingToDiagnostic(findings[0]!, findings.length),
						rawStatementSpan
					});
					return;
				}
				// Étape 3 — divergence hints INFO squiggly bleu discret.
				// Émises seulement quand engine === "mongodb" (PG = référence,
				// pas de divergence à surfacer). Priorité inférieure aux
				// warnings : n'affichée que si aucun warning unfiltered n'a
				// précédé.
				if (engine === "mongodb") {
					const hints = collectDivergenceHints(statement);
					if (hints.length > 0) {
						setState({
							diag: hintToDiagnostic(hints[0]!, hints.length),
							rawStatementSpan
						});
						return;
					}
					// Étape 4 — perf hints INFO pour les patterns non-indexables
					// Mongo (cast dans predicate write, correlated subquery).
					// Priorité inférieure aux divergences (info correction avant
					// info perf).
					const perf = collectPerfHints(statement);
					if (perf.length > 0) {
						setState({
							diag: perfToDiagnostic(perf[0]!, perf.length),
							rawStatementSpan
						});
						return;
					}
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
 * — évite un double parse quand le walker unfiltered tourne sur le même
 * statement dans la foulée.
 */
function validateStatement(
	statement: Statement,
	engine: string,
	schema: SchemaModel | undefined
): void {
	const caps = capabilitiesFor(engine);
	switch (statement.operation) {
		case "select": {
			const logical = lower(statement, schema);
			if (caps === undefined) return;
			// `plan()` couvre les refus engine-level (fonctions/casts/JSON/
			// aggregates/subquery/pushdown) — sinon un `find users pick
			// jsonb_col ->> 'k'` sur KV n'a de squiggly qu'au run.
			assertWithSpan(() => planLogical(logical, caps), statement);
			return;
		}
		case "insert":
		case "update":
		case "delete": {
			const mutationPlan = lowerMutation(statement, schema);
			if (caps === undefined) return;
			// Chaque assert refuse une capability spécifique (upsert /
			// write-join / insert-select / cast target / cast coercive Mongo).
			// La première qui throw remonte comme squiggly.
			assertWithSpan(
				() => assertMutationCastTargetsSupported(mutationPlan, caps),
				statement
			);
			assertWithSpan(
				() => assertMongoMutationWriteCastCoercive(mutationPlan, caps),
				statement
			);
			assertWithSpan(
				() => assertMutationUpsertSupported(mutationPlan, caps),
				statement
			);
			assertWithSpan(
				() => assertMutationWriteJoinSupported(mutationPlan, caps),
				statement
			);
			assertWithSpan(
				() => assertMutationInsertSelectSupported(mutationPlan, caps),
				statement
			);
			return;
		}
		case "transaction": {
			const txPlan = lowerTransaction(statement, schema);
			if (caps === undefined) return;
			assertWithSpan(
				() => assertTransactionSupported(txPlan, caps),
				statement
			);
			return;
		}
		case "introspect": {
			const introPlan = lowerIntrospect(statement, schema);
			if (caps === undefined) return;
			assertWithSpan(
				() => assertIntrospectSupported(introPlan, caps),
				statement
			);
			return;
		}
		case "raw":
			lowerRaw(statement);
			return;
		case "let": {
			const letPlan = lowerLet(statement, schema);
			if (caps === undefined) return;
			assertWithSpan(() => assertLetSupported(letPlan, caps), statement);
			return;
		}
		case "ddl": {
			// DDL Tier-2 (ADR-029). Deux niveaux de refus catchés en live :
			//  1. Planner : assertDDLSupported (capability 'ddl' absente ou kind
			//     non supporté par l'engine).
			//  2. Codegen : dry-run mapper.mapDDL — attrape les refus sémantiques
			//     admis (D13 PK Mongo ≠ id via codegen_mongo_primary_key_not_id)
			//     sans passer par l'Execute. Le dry-run est pur (aucune I/O), le
			//     coût est ~µs vs un roundtrip DB.
			const ddlPlan = lowerDDL(statement, schema);
			if (caps === undefined) return;
			assertWithSpan(() => assertDDLSupported(ddlPlan, caps), statement);
			// Dry-run codegen — n'a pas d'assert planner, throw directement
			// SnqlError si refus. Ancrage span via assertWithSpan comme pour
			// les autres asserts engine-level.
			assertWithSpan(() => {
				if (engine === "kv") {
					mapKvDDL(ddlPlan);
				} else if (engine === "postgres" || engine === "mongodb") {
					getMapper(engine).mapDDL?.(ddlPlan);
				}
			}, statement);
			return;
		}
		case "savepoint":
			// Standalone `savepoint` (hors transaction) n'est pas exécutable —
			// mais le parser l'accepte comme statement. Rien à valider ici.
			return;
	}
	// Défense : capability check symbolique pour un engine inconnu (au cas où
	// on route sur un mauvais moteur — refuse au niveau live diag avec un
	// message actionable).
	if (caps === undefined) {
		throw new SnqlError(`Moteur inconnu '${engine}'`, "unknown_engine");
	}
}

/**
 * Wrap un assert planner : si l'erreur remontée n'a pas de span (refus
 * engine-level qui ne cible pas un AST node précis), on ré-injecte celui du
 * statement pour ancrer la squiggly sur toute la query — sinon le live diag
 * la laisse tomber (guard `err.span !== undefined` dans useLiveDiagnostics).
 */
function assertWithSpan(fn: () => void, statement: Statement): void {
	try {
		fn();
	} catch (err) {
		if (err instanceof SnqlError && err.span === undefined) {
			throw new SnqlError(
				err.message,
				err.code as Parameters<typeof SnqlError>[1],
				statement.span
			);
		}
		throw err;
	}
}

/**
 * Convertit un finding "unfiltered write" en LiveDiagnostic warning. Suffixe
 * `(1/N)` quand plusieurs findings coexistent pour signaler que d'autres
 * suivent — la surface confirmation les listera tous.
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
 * Convertit un divergence hint en LiveDiagnostic `info`. Squiggly bleu
 * discret + tooltip hint depuis le registre `divergences-mongo-vs-pg`.
 * Suffixe `(1/N)` idem findings quand plusieurs hints coexistent.
 */
function hintToDiagnostic(
	hint: DivergenceHint,
	total: number
): LiveDiagnostic {
	const suffix = total > 1 ? ` (1/${total})` : "";
	return {
		span: hint.span,
		message: hint.message + suffix,
		severity: "info"
	};
}

/**
 * Convertit un perf hint en LiveDiagnostic `info` (même canal visual que
 * les divergences, distinct sémantiquement via le préfixe "⚡ perf:" dans
 * le message). Squiggly bleu discret + tooltip explique la cause + refactor.
 */
function perfToDiagnostic(hint: PerfHint, total: number): LiveDiagnostic {
	const suffix = total > 1 ? ` (1/${total})` : "";
	return {
		span: hint.span,
		message: hint.message + suffix,
		severity: "info"
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
