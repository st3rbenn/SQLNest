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
	type SnqlCompletionType,
	verbOperation
} from "@sqlnest/snql";

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
		const cmOptions: Completion[] = options.map((o) => ({
			label: o.label,
			type: CM_TYPE[o.type],
			...(o.detail !== undefined ? { detail: o.detail } : {}),
			// `apply` porte la clause `on` pré-remplie des jointures liées.
			...(o.apply !== undefined ? { apply: o.apply } : {})
		}));
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
		if (ch === "|") {
			stream.next();
			return "operator";
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

/**
 * Palette de coloration syntaxique dark-first.
 * - keyword (verbes SNQL, connecteurs) : accent Figma — mise en avant du
 *   squelette de la requête.
 * - string : vert clair (readable sur #2C2C2C).
 * - number : jaune warning Figma — chiffres sortent visuellement du texte.
 * - atom (true/false/null) : mauve pastel.
 * - operator (`|`) + comment : text-tertiary — décor, pas de bruit.
 * - variableName (identifiants) : text-primary — c'est le corps de la requête.
 */
const highlightStyle = HighlightStyle.define([
	{ tag: t.keyword, color: "#0d99ff", fontWeight: "600" },
	{ tag: t.string, color: "#4ddb99" },
	{ tag: t.number, color: "#ffc933" },
	{ tag: t.atom, color: "#c084fc" },
	{ tag: t.operator, color: "#7a7a7a" },
	{ tag: t.comment, color: "#7a7a7a", fontStyle: "italic" },
	{ tag: t.variableName, color: "#ffffff" }
]);

/** Coloration syntaxique SNQL (Token Dictionary partagé). */
export function snqlHighlighting(): Extension {
	return [snqlStream, syntaxHighlighting(highlightStyle)];
}
