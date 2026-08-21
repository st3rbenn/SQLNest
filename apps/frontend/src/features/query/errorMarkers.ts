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
 *
 * Sprint ADR-023 E/2 (D8) : ajout de `severity` — un walker "unfiltered
 * write" (voir `unfilteredWrites.ts`) émet des `warning` (couleur amber) qui
 * doivent être distingués visuellement des `error` de parse/lower (couleur
 * danger rouge, comportement legacy). `severity` optionnel — par défaut
 * `'error'` pour rétrocompat.
 *
 *  - `'error'`   — parse/lower a échoué, source syntaxiquement invalide (rouge danger).
 *  - `'warning'` — source valide mais dangereuse (unfiltered delete/update, bulk copy, raw opaque) — amber.
 *  - `'info'`    — signal passif non-bloquant (réservé aux badges permanents, décoration Raw etc.).
 */
export type LiveDiagnosticSeverity = "error" | "warning" | "info";
export interface LiveDiagnostic {
	readonly span: SerializedSpan;
	readonly message: string;
	readonly severity?: LiveDiagnosticSeverity;
}
export const setLiveDiagnostic = StateEffect.define<LiveDiagnostic | null>();

/** Défaut appliqué aux consumers qui ne set pas encore severity (rétrocompat). */
function severityOf(diag: LiveDiagnostic): LiveDiagnosticSeverity {
	return diag.severity ?? "error";
}

/**
 * [ADR-023 E/7.4 / D1] Décoration permanente pour un RawStatement racine.
 * Séparée du liveDiag (qui peut être écrasé par une squiggly unfiltered) —
 * tant que la source est un raw, l'icône "unsafe" reste dans la gutter et
 * son tooltip explique que ce bloc bypass la détection AST. Passe `null`
 * pour clear (source non-raw ou source invalide).
 */
export const setRawStatementSpan = StateEffect.define<SerializedSpan | null>();

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
 * DecorationSet dérivé du liveDiagField — squigglies sur le span, colorées
 * par severity via une classe CSS distincte. Séparé du errorField pgError
 * pour additivité visuelle (2 layers).
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
		// `sqlnest-error-mark` reste la couleur par défaut (rouge danger) via
		// text-decoration wavy défini SnqlEditor theme. La variante severity
		// est portée par une classe additionnelle utilisée dans le sélecteur
		// CSS `.sqlnest-error-mark.sqlnest-diag-severity-warning` etc.
		const severityClass = `sqlnest-diag-severity-${severityOf(diag)}`;
		builder.add(
			start,
			start + len,
			Decoration.mark({ class: `sqlnest-error-mark ${severityClass}` })
		);
		return builder.finish();
	}
);

/**
 * Marker dans la gutter à la ligne de l'erreur/warning live. Style CSS via
 * classe `.sqlnest-diag-gutter` (thème SnqlEditor) + attribute `data-severity`
 * lu par les règles CSS pour changer la couleur (danger/warning/info).
 */
class DiagGutterMarker extends GutterMarker {
	constructor(private readonly severity: LiveDiagnosticSeverity) {
		super();
	}
	override elementClass = "sqlnest-diag-gutter";
	override toDOM(): Node {
		// Un div vide sert de "peinture" via CSS (:before, background). Le
		// data-severity permet à SnqlEditor de router vers la bonne couleur.
		const el = document.createElement("div");
		el.dataset.severity = this.severity;
		return el;
	}
}
const DIAG_MARKERS: Record<LiveDiagnosticSeverity, DiagGutterMarker> = {
	error: new DiagGutterMarker("error"),
	warning: new DiagGutterMarker("warning"),
	info: new DiagGutterMarker("info")
};

const liveDiagGutter = gutter({
	class: "sqlnest-diag-gutter-slot",
	lineMarker(view, line) {
		const diag = view.state.field(liveDiagField, false);
		if (!diag) return null;
		const [start] = diag.span;
		if (start < 0 || start > view.state.doc.length) return null;
		const errorLine = view.state.doc.lineAt(start);
		if (errorLine.from === line.from) return DIAG_MARKERS[severityOf(diag)];
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

/** [ADR-023 E/7.4] StateField pour le span RawStatement racine — permanent
 * tant que la source est un raw. */
const rawStatementField = StateField.define<SerializedSpan | null>({
	create: () => null,
	update(current, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setRawStatementSpan)) return effect.value;
		}
		return current;
	}
});

/** Marker gutter permanent "unsafe" — icône ⚠ orange, tooltip au hover. */
class RawGutterMarker extends GutterMarker {
	override elementClass = "sqlnest-raw-gutter";
	override toDOM(): Node {
		const el = document.createElement("div");
		el.textContent = "⚠";
		el.title = "Ce bloc contourne la détection unfiltered — préférez SNQL quand possible";
		return el;
	}
}
const RAW_MARKER = new RawGutterMarker();

const rawStatementGutter = gutter({
	class: "sqlnest-raw-gutter-slot",
	lineMarker(view, line) {
		const span = view.state.field(rawStatementField, false);
		if (!span) return null;
		const [start] = span;
		if (start < 0 || start > view.state.doc.length) return null;
		const rawLine = view.state.doc.lineAt(start);
		if (rawLine.from === line.from) return RAW_MARKER;
		return null;
	},
	lineMarkerChange(update) {
		for (const tr of update.transactions) {
			for (const effect of tr.effects) {
				if (effect.is(setRawStatementSpan)) return true;
			}
		}
		return false;
	}
});

/**
 * Extension complète à ajouter à `EditorView.extensions`. Une fois montée,
 * le caller peut dispatcher :
 *  - `view.dispatch({ effects: setErrorSpans(spans) })` — pgError post-exec
 *  - `view.dispatch({ effects: setLiveDiagnostic({span, message, severity}) })` — live compile
 *  - `view.dispatch({ effects: setRawStatementSpan(span) })` — décoration Raw D1 permanente
 */
export function errorMarkers() {
	return [
		errorField,
		liveDiagField,
		liveDiagDecorations,
		liveDiagGutter,
		liveDiagTooltip,
		rawStatementField,
		rawStatementGutter,
		flush
	];
}
