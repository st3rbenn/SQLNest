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
 * Source de complétion CodeMirror déléguant au language service pur `completeSnql`
 * de `@sqlnest/snql`. Le SchemaModel courant est lu paresseusement (`getSchema`)
 * pour ne pas recréer l'éditeur au changement de moteur/schéma.
 */
export function snqlCompletion(
	getSchema: () => SchemaModel | undefined
): Extension {
	const source = (ctx: CompletionContext): CompletionResult | null => {
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

	return autocompletion({ override: [source], activateOnTyping: true });
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

const highlightStyle = HighlightStyle.define([
	{ tag: t.keyword, color: "#2563eb", fontWeight: "600" },
	{ tag: t.string, color: "#047857" },
	{ tag: t.number, color: "#b45309" },
	{ tag: t.atom, color: "#7c3aed" },
	{ tag: t.operator, color: "#94a3b8" },
	{ tag: t.comment, color: "#94a3b8", fontStyle: "italic" },
	{ tag: t.variableName, color: "#0f172a" }
]);

/** Coloration syntaxique SNQL (Token Dictionary partagé). */
export function snqlHighlighting(): Extension {
	return [snqlStream, syntaxHighlighting(highlightStyle)];
}
