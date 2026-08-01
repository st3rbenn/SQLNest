import { completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import {
	placeholder as cmPlaceholder,
	EditorView,
	keymap
} from "@codemirror/view";
import type { SchemaModel } from "@sqlnest/snql";
import { useEffect, useRef } from "react";
import { snqlCompletion, snqlHighlighting } from "./snql-language";

interface SnqlEditorProps {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly onRun: () => void;
	/** SchemaModel courant → candidats de complétion (absent = base non introspectée). */
	readonly schema: SchemaModel | undefined;
	readonly placeholder?: string;
}

/**
 * Thème dark de l'éditeur SNQL — aligné sur les tokens Figma.
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
			border: "1px solid var(--sqlnest-border)",
			borderRadius: "10px",
			backgroundColor: "var(--sqlnest-surface)",
			color: "var(--sqlnest-text-primary)"
		},
		"&.cm-focused": {
			outline: "none",
			borderColor: "var(--sqlnest-accent)"
		},
		".cm-content": {
			fontFamily: "var(--mantine-font-family-monospace)",
			padding: "12px 14px",
			minHeight: "84px",
			caretColor: "var(--sqlnest-accent)"
		},
		".cm-scroller": { lineHeight: "1.6" },
		// Sélection texte : accent Figma translucide. `::selection` seul
		// suffit ; les sélections multi-cursor de CM passent aussi par des
		// spans `.cm-selectionBackground` qu'on colore identiquement pour
		// homogénéité.
		"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
			{
				backgroundColor: "rgba(13, 153, 255, 0.28)"
			},
		// Placeholder : muted mais lisible.
		".cm-placeholder": {
			color: "var(--sqlnest-text-tertiary)"
		},
		// Popup d'autocomplétion : surface Figma + border, shadow noire.
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
 */
export function SnqlEditor({
	value,
	onChange,
	onRun,
	schema,
	placeholder
}: SnqlEditorProps) {
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
				keymap.of([
					{
						key: "Mod-Enter",
						run: () => {
							onRunRef.current();
							return true;
						}
					},
					...completionKeymap,
					...defaultKeymap,
					...historyKeymap
				]),
				snqlHighlighting(),
				snqlCompletion(() => schemaRef.current),
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

	return <div ref={host} />;
}
