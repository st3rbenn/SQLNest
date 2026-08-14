/**
 * Extension CodeMirror 6 : décorations pour les erreurs SNQL/PG.
 *
 * Deux flux indépendants :
 *  - `setErrorSpans([[start,length],…])` — erreurs Postgres remontées via
 *    `PgErrorInfo` (post-exécution). Squigglies rouges seulement.
 *  - `setLiveDiagnostic({span, message} | null)` — Sprint T2/live-diag :
 *    erreur compile local (lower/parser/planner SNQL) découverte pendant
 *    la frappe. Squiggly + badge rouge dans la gutter à la ligne + tooltip
 *    au hover sur le span (message d'erreur SNQL complet).
 *
 * Design : StateField séparés pour chaque flux (les 2 peuvent coexister —
 * live diag est overshadowed par pgError après exécution, mais visuellement
 * les 2 layers sont additives). Les marks (pas widgets) préservent la mesure
 * de texte.
 *
 * Styles CSS requis (SnqlEditor.theme) :
 *  - `.sqlnest-error-mark` — text-decoration wavy underline danger
 *  - `.sqlnest-diag-gutter` — chip rouge dans la gutter
 *  - `.sqlnest-diag-tooltip` — tooltip surface + border + text
 */
import {
	Decoration,
	type DecorationSet,
	EditorView,
	gutter,
	GutterMarker,
	hoverTooltip,
	ViewPlugin
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import type { SerializedSpan } from "./useRunQuery";

/** Dispatchée par le caller pour remplacer la liste des spans en erreur. */
export const setErrorSpans = StateEffect.define<readonly SerializedSpan[]>();

/**
 * Diagnostic live compile — un seul à la fois (les erreurs SNQL sont
 * séquentielles : parser stops au 1er problème, lower/planner idem).
 * `null` clear.
 */
export interface LiveDiagnostic {
	readonly span: SerializedSpan;
	readonly message: string;
}
export const setLiveDiagnostic = StateEffect.define<LiveDiagnostic | null>();

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
 * StateField pour le live diagnostic — un seul span+message actif à la fois.
 * Squiggly rouge sur le span (mark decoration), badge dans la gutter, message
 * exposé pour le hoverTooltip via ce même champ.
 */
const liveDiagField = StateField.define<LiveDiagnostic | null>({
	create: () => null,
	update(diag, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setLiveDiagnostic)) return effect.value;
		}
		// Si le doc change, le span peut être invalidé — on garde tel quel
		// (le hook debounced recomputera et dispatchera une valeur fraîche).
		return diag;
	}
});

/**
 * DecorationSet dérivé du liveDiagField — squigglies rouges sur le span.
 * Séparé du errorField pgError pour additivité visuelle (2 layers).
 */
const liveDiagDecorations = EditorView.decorations.compute(
	[liveDiagField],
	(state) => {
		const diag = state.field(liveDiagField);
		if (diag === null) return Decoration.none;
		const docLen = state.doc.length;
		const [start, len] = diag.span;
		if (start < 0 || len <= 0 || start + len > docLen) return Decoration.none;
		const builder = new RangeSetBuilder<Decoration>();
		builder.add(start, start + len, Decoration.mark({ class: "sqlnest-error-mark" }));
		return builder.finish();
	}
);

/**
 * Marker rouge dans la gutter à la ligne de l'erreur live. Style CSS via
 * classe `.sqlnest-diag-gutter` (thème SnqlEditor).
 */
class DiagGutterMarker extends GutterMarker {
	override elementClass = "sqlnest-diag-gutter";
}
const DIAG_MARKER = new DiagGutterMarker();

const liveDiagGutter = gutter({
	class: "sqlnest-diag-gutter-slot",
	lineMarker(view, line) {
		const diag = view.state.field(liveDiagField, false);
		if (!diag) return null;
		const [start] = diag.span;
		if (start < 0 || start > view.state.doc.length) return null;
		const errorLine = view.state.doc.lineAt(start);
		if (errorLine.from === line.from) return DIAG_MARKER;
		return null;
	},
	lineMarkerChange(update) {
		for (const tr of update.transactions) {
			for (const effect of tr.effects) {
				if (effect.is(setLiveDiagnostic)) return true;
			}
		}
		return false;
	}
});

/**
 * hoverTooltip — quand la souris survole le span en erreur live, affiche le
 * message d'erreur SNQL dans un tooltip attaché au caret. Rien à hover =
 * pas de tooltip.
 */
const liveDiagTooltip = hoverTooltip((view, pos) => {
	const diag = view.state.field(liveDiagField, false);
	if (!diag) return null;
	const [start, len] = diag.span;
	if (pos < start || pos > start + len) return null;
	return {
		pos: start,
		end: start + len,
		above: true,
		create() {
			const dom = document.createElement("div");
			dom.className = "sqlnest-diag-tooltip";
			dom.textContent = diag.message;
			return { dom };
		}
	};
});

/**
 * Extension complète à ajouter à `EditorView.extensions`. Une fois montée,
 * le caller peut dispatcher :
 *  - `view.dispatch({ effects: setErrorSpans(spans) })` — pgError post-exec
 *  - `view.dispatch({ effects: setLiveDiagnostic({span, message}) })` — live compile
 */
export function errorMarkers() {
	return [
		errorField,
		liveDiagField,
		liveDiagDecorations,
		liveDiagGutter,
		liveDiagTooltip,
		flush
	];
}
