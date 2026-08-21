import {
	acceptCompletion,
	closeBrackets,
	closeBracketsKeymap,
	completionKeymap,
	completionStatus,
	startCompletion
} from "@codemirror/autocomplete";
import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab
} from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
	placeholder as cmPlaceholder,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers
} from "@codemirror/view";
import type { SchemaModel } from "@sqlnest/snql";
import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef
} from "react";
import {
	errorMarkers,
	type LiveDiagnostic,
	setErrorSpans,
	setLiveDiagnostic,
	setRawStatementSpan
} from "./errorMarkers";
import { snqlCompletion, snqlHighlighting } from "./snql-language";
import type { SerializedSpan } from "./useRunQuery";

interface SnqlEditorProps {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly onRun: () => void;
	/** [ADR-023 E/5] Optional Mod-Shift-Enter callback → exec in transaction.
	 * Ajouté au CM keymap directement plutôt qu'au useHotkeys Mantine du
	 * parent, car ce dernier ne capture pas les keydowns quand le focus est
	 * dans le contenu CM (l'éditeur les absorbe avant remontée document).
	 * Le principe D10 tient : Mod-Enter reste unique exec safe, Mod-Shift-
	 * Enter est un sur-croît sécurité (tx = rollback sur erreur). */
	readonly onRunInTransaction?: () => void;
	/** SchemaModel courant → candidats de complétion (absent = base non introspectée). */
	readonly schema: SchemaModel | undefined;
	readonly placeholder?: string;
	/**
	 * Spans source SNQL à souligner en rouge (Phase 3a — erreurs Postgres
	 * résolues via `PgErrorInfo.paramSpans`). Une nouvelle liste remplace
	 * toutes les décorations existantes. `[]` clear.
	 */
	readonly errorSpans?: readonly SerializedSpan[];
	/**
	 * Diagnostic live (sprint T2/live-diag) : erreur compile SNQL découverte
	 * pendant la frappe. Squiggly + badge gutter + tooltip au hover. `null`
	 * clear (query valide ou pas d'erreur détectée).
	 */
	readonly liveDiagnostic?: LiveDiagnostic | null;
	/** [ADR-023 E/7.4 / D1] Span du RawStatement racine — quand présent, un
	 * marker gutter "unsafe" permanent + tooltip s'affiche pour rappeler que
	 * ce bloc contourne la détection unfiltered. Séparé de liveDiagnostic
	 * car cette décoration reste visible tant que la source est raw, alors
	 * que la squiggly peut être écrasée par une autre warning. */
	readonly rawStatementSpan?: SerializedSpan | null;
}

/**
 * Contrôleur impératif exposé via `ref` — permet à l'ErrorBlock de commander
 * un focus + scroll sur un span source SNQL précis (clic sur un chip `$N`),
 * et au ConsoleShellInner de rendre le focus après une cancelPending
 * WriteConfirmBar (ADR-023 E/3).
 */
export interface SnqlEditorHandle {
	/**
	 * Sélectionne le span dans l'éditeur, scrolle pour le rendre visible et
	 * met le focus. No-op si l'éditeur n'est pas monté ou si le span est
	 * hors des bornes du document.
	 */
	focusSpan(span: SerializedSpan): void;
	/**
	 * Rend le focus à l'éditeur sans changer la sélection courante. Utilisé
	 * par WriteConfirmBar → Escape / Annuler pour que le user retourne
	 * directement dans le flow CodeMirror sans re-cliquer.
	 */
	focus(): void;
}

/**
 * Thème dark de l'éditeur SNQL — aligné sur les tokens DS.
 *
 * CodeMirror ne consomme pas nos CSS vars directement dans les valeurs
 * `EditorView.theme()` (StyleModule les traite comme des chaînes opaques),
 * mais `var(--...)` en tant que valeur CSS fonctionne quand elle est
 * appliquée sur un élément DOM — donc on peut les utiliser ici. La
 * sélection utilise une teinte fixe (rgba direct) parce que CodeMirror
 * gère le highlight via un pseudo-element où les CSS vars nous ont posé
 * problème historiquement.
 */
const theme = EditorView.theme(
	{
		"&": {
			fontSize: "14px",
			border: "none",
			backgroundColor: "var(--sqlnest-canvas-bg)",
			color: "var(--sqlnest-text-primary)",
			height: "100%"
		},
		"&.cm-focused": {
			outline: "none"
		},
		".cm-content": {
			fontFamily: "var(--mantine-font-family-monospace)",
			padding: "12px 14px",
			caretColor: "var(--sqlnest-accent)"
		},
		".cm-scroller": {
			overflow: "auto",
			lineHeight: "1.6"
		},
		// Sélection texte : accent translucide. `::selection` seul suffit ;
		// les sélections multi-cursor de CM passent aussi par des spans
		// `.cm-selectionBackground` qu'on colore identiquement pour
		// homogénéité.
		"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
			{
				backgroundColor: "rgba(13, 153, 255, 0.28)"
			},
		// Placeholder : muted mais lisible.
		".cm-placeholder": {
			color: "var(--sqlnest-text-tertiary)"
		},
		// Popup d'autocomplétion : surface DS + border, shadow noire.
		".cm-tooltip-autocomplete": {
			background: "var(--sqlnest-surface)",
			border: "1px solid var(--sqlnest-border)",
			borderRadius: "8px",
			color: "var(--sqlnest-text-primary)",
			boxShadow: "0 8px 24px rgba(0,0,0,0.5)"
		},
		".cm-tooltip-autocomplete > ul > li[aria-selected]": {
			background: "var(--sqlnest-accent-soft)",
			color: "var(--sqlnest-accent)"
		},
		".cm-tooltip-autocomplete > ul > li": {
			padding: "3px 8px"
		},
		// Gutter (line numbers) — style IDE : bg canvas-bg subtil, chiffres
		// text-tertiary, séparé du contenu par une bordure droite discrète.
		".cm-gutters": {
			background: "var(--sqlnest-canvas-bg)",
			borderRight: "1px solid var(--sqlnest-border-subtle)",
			color: "var(--sqlnest-text-tertiary)"
		},
		".cm-lineNumbers .cm-gutterElement": {
			padding: "0 8px 0 12px",
			fontSize: "11.5px",
			fontVariantNumeric: "tabular-nums",
			minWidth: "24px",
			textAlign: "right"
		},
		".cm-activeLineGutter": {
			background: "var(--sqlnest-surface-hover)",
			color: "var(--sqlnest-text-primary)"
		},
		".cm-activeLine": {
			background: "transparent"
		},
		// Squigglies rouges sous les tokens source des erreurs Postgres (Phase 3a).
		// text-decoration wavy + underline-color : rendu natif partout, pas d'SVG.
		// Par défaut = danger ; surchargé par sqlnest-diag-severity-{warning,info}
		// pour les live diags (ADR-023 E/2 D8).
		".sqlnest-error-mark": {
			textDecoration: "underline wavy var(--sqlnest-danger)",
			textDecorationThickness: "1px",
			textUnderlineOffset: "3px"
		},
		".sqlnest-error-mark.sqlnest-diag-severity-warning": {
			textDecoration: "underline wavy var(--sqlnest-warning)"
		},
		".sqlnest-error-mark.sqlnest-diag-severity-info": {
			textDecoration: "underline wavy var(--sqlnest-text-tertiary)"
		},
		// Live diagnostic (sprint T2/live-diag) : barre verticale colorée dans
		// la gutter, pleine hauteur de la ligne. Style compact type IDE. Couleur
		// routée via data-severity (ADR-023 E/2 D8).
		".sqlnest-diag-gutter-slot": {
			width: "3px",
			padding: 0
		},
		".sqlnest-diag-gutter": {
			display: "block",
			width: "3px",
			height: "100%",
			background: "var(--sqlnest-danger)"
		},
		".sqlnest-diag-gutter > div[data-severity='warning']": {
			background: "var(--sqlnest-warning)",
			width: "3px",
			height: "100%"
		},
		".sqlnest-diag-gutter > div[data-severity='info']": {
			background: "var(--sqlnest-text-tertiary)",
			width: "3px",
			height: "100%"
		},
		".sqlnest-diag-gutter > div[data-severity='error']": {
			background: "var(--sqlnest-danger)",
			width: "3px",
			height: "100%"
		},
		// [ADR-023 E/7.4 / D1] Décoration permanente RawStatement — icône
		// warning centré dans une gutter dédiée, tooltip natif au hover via
		// title=. Distinct de la gutter live-diag (warning/error éphémère).
		".sqlnest-raw-gutter-slot": {
			minWidth: "14px",
			padding: 0,
			display: "flex",
			alignItems: "flex-start",
			justifyContent: "center"
		},
		".sqlnest-raw-gutter": {
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			width: "14px",
			height: "18px",
			color: "var(--sqlnest-warning)",
			fontSize: 11,
			cursor: "help",
			lineHeight: 1
		},
		// Tooltip au hover sur un span en erreur live — surface DS + border
		// danger discret, monospace pour aligner avec le code.
		".sqlnest-diag-tooltip": {
			maxWidth: "480px",
			padding: "8px 10px",
			background: "var(--sqlnest-surface)",
			color: "var(--sqlnest-text-primary)",
			border: "1px solid var(--sqlnest-danger-border)",
			borderRadius: "6px",
			boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
			fontSize: "12px",
			lineHeight: "1.5",
			fontFamily: "var(--mantine-font-family-monospace)",
			whiteSpace: "pre-wrap",
			wordBreak: "break-word"
		},
		".cm-tooltip.cm-tooltip-hover": {
			background: "transparent",
			border: "none"
		}
	},
	{ dark: true }
);

/**
 * Éditeur SNQL basé sur CodeMirror 6 : complétion schema-aware (via le language
 * service pur `completeSnql`), coloration syntaxique, Ctrl/⌘+Entrée pour exécuter.
 *
 * L'instance CM est créée **une fois** ; `schema`, `onRun` et `onChange` sont lus
 * via des refs pour rester à jour sans reconstruire l'éditeur (changement de
 * moteur/schéma). La prop `value` est synchronisée dans un sens (parent → éditeur)
 * uniquement quand elle diverge du document, pour éviter les boucles.
 *
 * `errorSpans` (Phase 3a) : liste de spans source à souligner en squiggle rouge —
 * dispatché en `StateEffect` sans reconstruire l'éditeur. Le `ref` expose
 * `focusSpan(span)` pour scroller / sélectionner un span depuis l'ErrorBlock.
 */
export const SnqlEditor = forwardRef<SnqlEditorHandle, SnqlEditorProps>(
	function SnqlEditor(
		{
			value,
			onChange,
			onRun,
			onRunInTransaction,
			schema,
			placeholder,
			errorSpans,
			liveDiagnostic,
			rawStatementSpan
		},
		ref
	) {
		const host = useRef<HTMLDivElement>(null);
		const view = useRef<EditorView | null>(null);
		const onChangeRef = useRef(onChange);
		const onRunRef = useRef(onRun);
		const onRunInTxRef = useRef(onRunInTransaction);
		const schemaRef = useRef<SchemaModel | undefined>(schema);

		// Garde les callbacks/schema à jour pour les extensions (créées une seule fois).
		onChangeRef.current = onChange;
		onRunRef.current = onRun;
		onRunInTxRef.current = onRunInTransaction;
		schemaRef.current = schema;

		// biome-ignore lint/correctness/useExhaustiveDependencies: l'éditeur est monté une fois ; les valeurs vivantes passent par des refs.
		useEffect(() => {
			if (host.current === null) {
				return;
			}
			const state = EditorState.create({
				doc: value,
				extensions: [
					history(),
					lineNumbers(),
					highlightActiveLine(),
					highlightActiveLineGutter(),
					keymap.of([
						{
							key: "Mod-Enter",
							run: () => {
								onRunRef.current();
								return true;
							}
						},
						{
							// [ADR-023 E/5] Mod-Shift-Enter = exec in tx. Bind ici
							// (CM keymap) plutôt que useHotkeys parent, car CM capte
							// les keydowns avant remontée document quand le focus
							// est dans le contenu — le useHotkeys Mantine ne
							// déclencherait jamais. Fallback no-op silencieux si
							// la callback n'est pas fournie (compat rétro).
							key: "Mod-Shift-Enter",
							run: () => {
								const cb = onRunInTxRef.current;
								if (cb === undefined) return false;
								cb();
								return true;
							}
						},
						// Sprint T2/13.6 : Tab accepte le candidat courant quand le
						// popup d'autocomplete est ouvert ; sinon fallthrough vers
						// `indentWithTab` (comportement historique).
						{
							key: "Tab",
							run: (view) => {
								if (completionStatus(view.state) === "active") {
									return acceptCompletion(view);
								}
								return false;
							}
						},
						indentWithTab,
						...closeBracketsKeymap,
						...completionKeymap,
						...defaultKeymap,
						...historyKeymap
					]),
					// Sprint T2/13.7 : auto-pair des `"`/`'`/`{`/`[`/`(` — quand
					// l'user tape `"`, la fermeture est insérée et le curseur
					// atterrit entre les deux (Backspace supprime la paire, `"`
					// juste avant la fermeture skip au lieu de re-insérer).
					closeBrackets(),
					snqlHighlighting(),
					snqlCompletion(() => schemaRef.current),
					errorMarkers(),
					EditorView.lineWrapping,
					EditorView.updateListener.of((update) => {
						if (update.docChanged) {
							onChangeRef.current(update.state.doc.toString());
							// Sprint T2/13.7 : après un auto-pair `""` (closeBrackets
							// vient d'insérer `""` + placé le curseur au milieu),
							// trigger le popup pour proposer les enum labels /
							// autocomplete de valeur. Détection : cette transaction
							// contient une insertion de `""` (2 chars) ET le curseur
							// est pile au milieu.
							//
							// Guard IME (bug user 2026-08 : après delete, les
							// caractères se répétaient) : startCompletion pendant
							// une composition IME peut verrouiller le state
							// composition du browser. On skip si compositionend
							// n'a pas encore été fire.
							if (
								didAutoPairQuote(update) &&
								!update.view.composing
							) {
								startCompletion(update.view);
							}
						}
					}),
					...(placeholder !== undefined ? [cmPlaceholder(placeholder)] : []),
					theme
				]
			});
			const editor = new EditorView({ state, parent: host.current });
			view.current = editor;
			return () => {
				editor.destroy();
				view.current = null;
			};
		}, []);

		// Synchronise value → éditeur (ex. bascule d'exemple), sans boucle.
		useEffect(() => {
			const editor = view.current;
			if (editor !== null && value !== editor.state.doc.toString()) {
				editor.dispatch({
					changes: { from: 0, to: editor.state.doc.length, insert: value }
				});
			}
		}, [value]);

		// Stabilise la liste — évite les dispatch superflus si le parent passe une
		// ref différente à chaque rendu. Comparaison profonde peu coûteuse (petites
		// listes de spans, ≤ 5 typiquement). Défensif : ignore les entrées mal
		// formées (tuple d'arité != 2, valeurs non numériques) plutôt que de
		// crasher au destructuring — la source pgError peut remonter du null.
		const spansKey = useMemo(
			() =>
				(errorSpans ?? [])
					.filter(
						(v): v is SerializedSpan =>
							Array.isArray(v) &&
							v.length === 2 &&
							typeof v[0] === "number" &&
							typeof v[1] === "number"
					)
					.map((s) => `${s[0]}:${s[1]}`)
					.join(","),
			[errorSpans]
		);

		// Sync `errorSpans` → décorations CM (Phase 3a). Dispatch un StateEffect
		// que le `errorField` interprète pour remplacer le DecorationSet.
		useEffect(() => {
			const editor = view.current;
			if (editor === null) return;
			editor.dispatch({ effects: setErrorSpans.of(errorSpans ?? []) });
		}, [spansKey, errorSpans]);

		// Sync liveDiagnostic → StateField dédié (squiggly + gutter + tooltip).
		// Clé stable pour éviter re-dispatch sur ref différente à chaque render.
		const diagKey = useMemo(() => {
			if (!liveDiagnostic) return "";
			return `${liveDiagnostic.span[0]}:${liveDiagnostic.span[1]}:${liveDiagnostic.message}`;
		}, [liveDiagnostic]);
		useEffect(() => {
			const editor = view.current;
			if (editor === null) return;
			editor.dispatch({ effects: setLiveDiagnostic.of(liveDiagnostic ?? null) });
		}, [diagKey, liveDiagnostic]);

		// [ADR-023 E/7.4 / D1] Sync rawStatementSpan → décoration permanente
		// (gutter icon "unsafe" + tooltip). Séparé du liveDiag pour rester
		// visible même quand la squiggly change.
		const rawKey = useMemo(() => {
			if (!rawStatementSpan) return "";
			return `${rawStatementSpan[0]}:${rawStatementSpan[1]}`;
		}, [rawStatementSpan]);
		useEffect(() => {
			const editor = view.current;
			if (editor === null) return;
			editor.dispatch({
				effects: setRawStatementSpan.of(rawStatementSpan ?? null)
			});
		}, [rawKey, rawStatementSpan]);

		useImperativeHandle(
			ref,
			() => ({
				focusSpan(span) {
					const editor = view.current;
					if (editor === null) return;
					const docLen = editor.state.doc.length;
					const [start, length] = span;
					if (start < 0 || length <= 0 || start + length > docLen) return;
					editor.dispatch({
						selection: EditorSelection.range(start, start + length),
						scrollIntoView: true
					});
					editor.focus();
				},
				focus() {
					view.current?.focus();
				}
			}),
			[]
		);

		return (
			<div
				ref={host}
				style={{ height: "100%", display: "flex", flexDirection: "column" }}
			/>
		);
	}
);

/**
 * Sprint T2/13.7 : détecte qu'une transaction vient d'insérer une paire de
 * guillemets (`""` ou `''`) via `closeBrackets` et que le curseur est au
 * milieu. On regarde tous les changements insérés : si l'un est exactement
 * `""` (ou `''`) et que le curseur main est pile après la 1re quote, c'est
 * un auto-pair déclenché par l'user qui a tapé `"`.
 */
function didAutoPairQuote(update: import("@codemirror/view").ViewUpdate): boolean {
	let matched = false;
	update.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
		if (matched) return;
		const text = inserted.toString();
		if (text !== '""' && text !== "''") return;
		const mainHead = update.state.selection.main.head;
		// closeBrackets place le curseur pile entre les 2 quotes → fromB + 1
		// (toB = fromB + 2 pour une paire).
		if (mainHead === fromB + 1 && toB === fromB + 2) {
			matched = true;
		}
	});
	return matched;
}
