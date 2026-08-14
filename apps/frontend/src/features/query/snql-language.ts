import {
	autocompletion,
	type Completion,
	type CompletionContext,
	type CompletionResult
} from "@codemirror/autocomplete";
import {
	HighlightStyle,
	StreamLanguage,
	type StringStream,
	syntaxHighlighting
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import {
	completeSnql,
	KEYWORDS,
	type SchemaModel,
	type SnqlCompletion,
	type SnqlCompletionType,
	verbOperation
} from "@sqlnest/snql";
import type { EditorView } from "@codemirror/view";

// --- Complétion schema-aware -------------------------------------------------

/** Catégorie SNQL → type de complétion CodeMirror (pilote l'icône). */
const CM_TYPE: Readonly<Record<SnqlCompletionType, string>> = {
	verb: "keyword",
	keyword: "keyword",
	collection: "class",
	field: "property",
	relation: "function",
	alias: "variable"
};

// Le contexte de complétion ne change pas tant qu'on tape des identifiants : CM
// peut filtrer localement (validFor) sans re-solliciter la source.
const IDENT_CONTINUE = /^[A-Za-z0-9_]*$/;

/**
 * Source CodeMirror pure — délègue au language service `completeSnql` du cœur et
 * mappe les catégories SNQL vers les types d'icônes CM. Exportée séparément pour
 * pouvoir la tester sans instancier un `EditorView`.
 */
export function snqlCompletionSource(
	getSchema: () => SchemaModel | undefined
): (ctx: CompletionContext) => CompletionResult | null {
	return (ctx) => {
		const schema = getSchema();
		if (schema === undefined) {
			return null;
		}
		const { from, options } = completeSnql(
			ctx.state.doc.toString(),
			ctx.pos,
			schema
		);
		if (options.length === 0) {
			return null;
		}
		// `boost` : sans ça, CodeMirror re-trie par pertinence/label alpha et noie
		// notre ordre pédagogique (les mots-clés `one`/`many` en tête après `with`,
		// les collections liées avant les autres). On boost décroissant selon
		// l'index source (99 → 0, tronqué à 100) pour préserver l'ordre.
		const cmOptions: Completion[] = options.map((o, i) => {
			const applyFn = pickApply(o);
			return {
				label: o.label,
				type: CM_TYPE[o.type],
				boost: Math.max(0, 99 - i),
				...(o.detail !== undefined ? { detail: o.detail } : {}),
				...(applyFn !== null ? { apply: applyFn } : {})
			};
		});
		return {
			from,
			options: cmOptions,
			// Tant que l'utilisateur tape des caractères d'identifiant, CM filtre
			// sans re-interroger la source (le contexte ne change pas).
			validFor: IDENT_CONTINUE
		};
	};
}

/**
 * Sprint T2/13.6 : choisit le apply pour un candidat.
 *  - `o.apply` string custom (ex. `on <local> = <foreign>` d'un with) → priorité.
 *  - `o.insertKind` (fields de doc/set) → apply function smart : insère
 *    `<name>: "|"` ou `<name>: |` avec indent auto si l'user vient de taper
 *    `{`/`,`. Curseur positionné pour taper directement la valeur.
 *  - Sinon `null` (renderer laisse CM insérer `label` nu).
 */
function pickApply(
	o: SnqlCompletion
): string | ((view: EditorView, _c: Completion, from: number, to: number) => void) | null {
	if (o.apply !== undefined) return o.apply;
	if (o.insertKind !== undefined) return smartFieldApply(o.label, o.insertKind);
	return null;
}

function smartFieldApply(name: string, kind: "string" | "number" | "raw") {
	return (view: EditorView, _c: Completion, from: number, to: number): void => {
		const doc = view.state.doc;
		const lineAtFrom = doc.lineAt(from);
		const beforeCursorInLine = lineAtFrom.text.slice(0, from - lineAtFrom.from);
		const onFreshLine = beforeCursorInLine.trim() === "";

		// Char non-whitespace le plus récent AVANT `from` (regarde jusqu'à 60 chars
		// avant, largement suffisant pour trouver le `{` ou `,`).
		const scan = doc.sliceString(Math.max(0, from - 60), from);
		const trimmed = scan.replace(/\s+$/, "");
		const lastNonWs = trimmed.slice(-1);
		const afterOpener = lastNonWs === "{" || lastNonWs === ",";

		// Prepend `\n<indent>` si l'user est encore sur la même ligne que le
		// `{` / `,` (donc pas déjà à une nouvelle ligne indentée). Indent = 4
		// espaces, cohérent avec le formatter block-style existant.
		const prefix = !onFreshLine && afterOpener ? "\n    " : "";

		// Construit l'insertion + position curseur selon kind.
		let insert: string;
		let cursorFromStart: number;
		if (kind === "string") {
			insert = `${prefix}${name}: ""`;
			cursorFromStart = insert.length - 1; // entre les guillemets
		} else {
			// number / raw : espace après `:`, pas de quote.
			insert = `${prefix}${name}: `;
			cursorFromStart = insert.length;
		}

		view.dispatch({
			changes: { from, to, insert },
			selection: { anchor: from + cursorFromStart }
		});
	};
}

/**
 * Extension CodeMirror : câble `snqlCompletionSource` dans le pipeline
 * `autocompletion`. Le SchemaModel courant est lu paresseusement (`getSchema`)
 * pour ne pas recréer l'éditeur au changement de moteur/schéma.
 */
export function snqlCompletion(
	getSchema: () => SchemaModel | undefined
): Extension {
	return autocompletion({
		override: [snqlCompletionSource(getSchema)],
		activateOnTyping: true
	});
}

// --- Coloration syntaxique (StreamLanguage, tokens = Token Dictionary) --------

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const NUMBER_PART = /[0-9.]/;

/**
 * Tokenizer incrémental minimal pour la coloration. Il ne réimplémente pas la
 * grammaire : il classe chaque mot via le **même** Token Dictionary que le cœur
 * (`verbOperation` / `KEYWORDS`), donc pas de dérive de vocabulaire.
 */
interface StreamState {
	inString: string | null;
}

const snqlStream = StreamLanguage.define<StreamState>({
	startState: () => ({ inString: null }),
	token(stream, state) {
		// Poursuite d'une chaîne ouverte sur une ligne précédente.
		if (state.inString !== null) {
			return consumeString(stream, state);
		}
		if (stream.eatSpace()) {
			return null;
		}
		const ch = stream.peek() ?? "";

		if (ch === "#") {
			stream.skipToEnd();
			return "comment";
		}
		if (ch === '"' || ch === "'") {
			stream.next();
			state.inString = ch;
			return consumeString(stream, state);
		}
		if (ch >= "0" && ch <= "9") {
			stream.eatWhile(NUMBER_PART);
			return "number";
		}
		if (IDENT_START.test(ch)) {
			stream.eatWhile(IDENT_PART);
			return classifyWord(stream.current());
		}
		stream.next();
		return null;
	}
});

/** Consomme une chaîne littérale (gère l'échappement `\`). */
function consumeString(stream: StringStream, state: StreamState): string {
	let escaped = false;
	while (!stream.eol()) {
		const c = stream.next();
		if (escaped) {
			escaped = false;
		} else if (c === "\\") {
			escaped = true;
		} else if (c === state.inString) {
			state.inString = null;
			break;
		}
	}
	return "string";
}

/** Classe un mot via le Token Dictionary partagé. */
function classifyWord(word: string): string {
	const lower = word.toLowerCase();
	if (lower === "true" || lower === "false" || lower === "null") {
		return "atom";
	}
	if (verbOperation(lower) !== undefined) {
		return "keyword";
	}
	if (KEYWORDS.has(lower)) {
		return "keyword";
	}
	return "variableName";
}

const highlightStyle = HighlightStyle.define([
	{ tag: t.keyword, color: "#0d99ff", fontWeight: "600" },
	{ tag: t.string, color: "#4ddb99" },
	{ tag: t.number, color: "#ffc933" },
	{ tag: t.atom, color: "#c084fc" },
	{ tag: t.comment, color: "#7a7a7a", fontStyle: "italic" },
	{ tag: t.variableName, color: "#ffffff" }
]);

/** Coloration syntaxique SNQL (Token Dictionary partagé). */
export function snqlHighlighting(): Extension {
	return [snqlStream, syntaxHighlighting(highlightStyle)];
}
