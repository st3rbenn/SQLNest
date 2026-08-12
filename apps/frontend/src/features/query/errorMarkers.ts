/**
 * Extension CodeMirror 6 : décorations underline squiggle rouges sur les spans
 * sources SNQL des erreurs Postgres (Phase 3a — remonte via `PgErrorInfo`).
 *
 * Design : un `StateField<DecorationSet>` piloté par un `StateEffect`. Le
 * caller externe dispatche `setErrorSpans([[start, length], …])` quand une
 * nouvelle erreur arrive (ou `[]` pour clear). Les décorations sont des marks
 * (pas des widgets) pour ne pas perturber la mesure de largeur du texte.
 *
 * Le style CSS `.sqlnest-error-mark` doit être défini globalement (voir le
 * thème `SnqlEditor.theme`) — text-decoration wavy underline en danger.
 */
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import type { SerializedSpan } from "./useRunQuery";

/** Dispatchée par le caller pour remplacer la liste des spans en erreur. */
export const setErrorSpans = StateEffect.define<readonly SerializedSpan[]>();

/**
 * StateField qui accumule les décorations à afficher. Recalculé à chaque
 * `setErrorSpans` — pas besoin d'update incrémentale (les erreurs sont peu
 * nombreuses, en général ≤ 3 spans par requête).
 */
const errorField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setErrorSpans)) {
				const builder = new RangeSetBuilder<Decoration>();
				const docLen = tr.state.doc.length;
				// Défensif : chaque span DOIT être un tuple [number, number] non-null
				// avant destructuring. Un span mal formé remonté via le wire est
				// filtré ici pour ne pas crasher `[start, len] = null`.
				const sorted = [...effect.value]
					.filter(
						(v): v is SerializedSpan =>
							Array.isArray(v) &&
							v.length === 2 &&
							typeof v[0] === "number" &&
							typeof v[1] === "number"
					)
					.filter(([start, len]) => start >= 0 && len > 0 && start + len <= docLen)
					.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
				const mark = Decoration.mark({ class: "sqlnest-error-mark" });
				for (const [start, len] of sorted) {
					builder.add(start, start + len, mark);
				}
				return builder.finish();
			}
		}
		// Pas d'update spécifique — la décoration se déplace toute seule via CM
		// (Decoration.mark suit les insertions/suppressions dans son intervalle).
		return deco.map(tr.changes);
	},
	provide: (f) => EditorView.decorations.from(f)
});

/**
 * Assure au moins un frame de rendu quand les décorations changent — évite
 * les cas où CM ne re-mesure pas la ligne car aucune autre modification n'a
 * eu lieu ce frame. Sans coût mesurable.
 */
const flush = ViewPlugin.define(() => ({}));

/**
 * Extension complète à ajouter à `EditorView.extensions`. Une fois montée,
 * le caller peut dispatcher `view.dispatch({ effects: setErrorSpans(spans) })`
 * pour actualiser les décorations.
 */
export function errorMarkers() {
	return [errorField, flush];
}
