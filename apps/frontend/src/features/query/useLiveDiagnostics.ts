/**
 * useLiveDiagnostics — compile SNQL local debounced pendant que l'user tape.
 * Retourne le diagnostic courant (span + message) ou null si la query est
 * syntaxiquement valide (au sens du lower schema-aware).
 *
 * ─── Comportement ─────────────────────────────────────────────────────
 * - Debounce 300ms après la dernière frappe (évite le stuttering + laisse
 *   à l'user le temps de finir de taper un token).
 * - Compile via `compile(source, {engine, schema})` — même pipeline que
 *   l'exécution, donc erreurs identiques : parser / lower / planner /
 *   typecheck cross-type. Sub-queries + walkers inclus.
 * - Source vide → null (rien à valider).
 * - Erreurs "obviously incomplete" (source trop courte, se termine par un
 *   opérateur/comma) → null (bruit pendant la frappe).
 *
 * ─── Sécurité ────────────────────────────────────────────────────────
 * Le compile est CÔTÉ CLIENT — aucune requête réseau, aucun accès DB.
 * Le schema utilisé est celui déjà chargé pour l'autocomplete (SchemaModel
 * en mémoire, provenance CLI). Zero surface d'attaque.
 */

import { compile, SnqlError, type SchemaModel } from "@sqlnest/snql";
import { useEffect, useState } from "react";
import type { LiveDiagnostic } from "./errorMarkers";
import type { SerializedSpan } from "./useRunQuery";

/** Délai d'inactivité avant de re-compiler. Trade-off réactivité vs bruit. */
const DEBOUNCE_MS = 300;

/**
 * Retourne le diagnostic live courant, ou null si la query est valide (ou
 * pas encore prête à être validée). Recalcule debounced à chaque changement
 * de source/schema/engine.
 */
export function useLiveDiagnostics(
	source: string,
	engine: string,
	schema: SchemaModel | undefined
): LiveDiagnostic | null {
	const [diag, setDiag] = useState<LiveDiagnostic | null>(null);

	useEffect(() => {
		if (isObviouslyIncomplete(source)) {
			setDiag(null);
			return;
		}
		const handle = setTimeout(() => {
			try {
				compile(source, { engine, schema });
				setDiag(null); // valide
			} catch (err) {
				if (err instanceof SnqlError && err.span !== undefined) {
					const span: SerializedSpan = [
						err.span.start.offset,
						err.span.end.offset - err.span.start.offset
					];
					setDiag({ span, message: err.message });
				} else if (err instanceof Error) {
					// Erreur sans span (rare : plan sans traçabilité). Silent —
					// on préfère ne pas afficher un tooltip orphelin.
					setDiag(null);
				} else {
					setDiag(null);
				}
			}
		}, DEBOUNCE_MS);
		return () => clearTimeout(handle);
	}, [source, engine, schema]);

	return diag;
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
