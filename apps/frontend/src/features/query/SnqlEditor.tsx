import { completionKeymap } from "@codemirror/autocomplete";
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
	setLiveDiagnostic
} from "./errorMarkers";
import { snqlCompletion, snqlHighlighting } from "./snql-language";
import type { SerializedSpan } from "./useRunQuery";

interface SnqlEditorProps {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly onRun: () => void;
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
}

/**
 * Contrôleur impératif exposé via `ref` — permet à l'ErrorBlock de commander
 * un focus + scroll sur un span source SNQL précis (clic sur un chip `$N`).
 */
export interface SnqlEditorHandle {
	/**
	 * Sélectionne le span dans l'éditeur, scrolle pour le rendre visible et
	 * met le focus. No-op si l'éditeur n'est pas monté ou si le span est
	 * hors des bornes du document.
	 */
	focusSpan(span: SerializedSpan): void;
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
		".sqlnest-error-mark": {
			textDecoration: "underline wavy var(--sqlnest-danger)",
			textDecorationThickness: "1px",
			textUnderlineOffset: "3px"
		},
		// Live diagnostic (sprint T2/live-diag) : badge dans la gutter à la
		// ligne de l'erreur compile locale. Petit rond rouge minimaliste —
		// style VSCode marker, aligné visuellement au numéro de ligne.
		".sqlnest-diag-gutter-slot": {
			width: "12px",
			padding: 0
		},
		".sqlnest-diag-gutter": {
			display: "block",
			width: "6px",
			height: "6px",
			margin: "6px auto 0",
			borderRadius: "50%",
			background: "var(--sqlnest-danger)"
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
		{ value, onChange, onRun, schema, placeholder, errorSpans, liveDiagnostic },
		ref
	) {
		const host = useRef<HTMLDivElement>(null);
		const view = useRef<EditorView | null>(null);
		const onChangeRef = useRef(onChange);
		const onRunRef = useRef(onRun);
		const schemaRef = useRef<SchemaModel | undefined>(schema);

		// Garde les callbacks/schema à jour pour les extensions (créées une seule fois).
		onChangeRef.current = onChange;
		onRunRef.current = onRun;
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
						indentWithTab,
						...completionKeymap,
						...defaultKeymap,
						...historyKeymap
					]),
					snqlHighlighting(),
					snqlCompletion(() => schemaRef.current),
					errorMarkers(),
					EditorView.lineWrapping,
					EditorView.updateListener.of((update) => {
						if (update.docChanged) {
							onChangeRef.current(update.state.doc.toString());
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

