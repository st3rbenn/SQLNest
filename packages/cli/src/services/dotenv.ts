/**
 * Lecture d'un fichier `.env` (ADR-038 S4), comme dotenv + dotenv-expand
 * (ce que lit Prisma) : `CLÉ=valeur`, préfixe `export`, commentaires `#`,
 * valeurs entre quotes. Dans une valeur sans quotes ou entre guillemets,
 * `${AUTRE}`, `${AUTRE:-défaut}` et `$AUTRE` prennent la valeur d'une clé
 * du fichier, sinon de `env` ; `\$` reste un `$`.
 */

const KEY_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
const EXPANSION_RE =
	/\\\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

const INLINE_COMMENT_RE = /\s#/;

interface RawValue {
	readonly text: string;
	readonly expand: boolean;
}

export function parseDotenv(
	content: string,
	env: NodeJS.ProcessEnv = {}
): Record<string, string> {
	const raw = new Map<string, RawValue>();
	const lines = content.replace(/\r\n?/g, "\n").split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = (lines[i] as string).trim();
		if (line === "" || line.startsWith("#")) continue;
		const match = KEY_RE.exec(line);
		if (match === null) continue;
		const key = match[1] as string;
		let rest = match[2] as string;
		const quote = rest[0];
		if (quote === '"' || quote === "'" || quote === "`") {
			// Une valeur entre quotes peut continuer sur les lignes suivantes.
			let body = rest.slice(1);
			let close = findClosingQuote(body, quote);
			while (close < 0 && i + 1 < lines.length) {
				i += 1;
				body += `\n${lines[i]}`;
				close = findClosingQuote(body, quote);
			}
			rest = close >= 0 ? body.slice(0, close) : body;
			raw.set(key, {
				text: quote === '"' ? unescapeDoubleQuoted(rest) : rest,
				expand: quote === '"'
			});
		} else {
			const comment = rest.search(INLINE_COMMENT_RE);
			raw.set(key, {
				text: (comment >= 0 ? rest.slice(0, comment) : rest).trim(),
				expand: true
			});
		}
	}

	const resolved = new Map<string, string>();
	const resolving = new Set<string>();
	const resolve = (key: string): string | undefined => {
		const known = resolved.get(key);
		if (known !== undefined) return known;
		const value = raw.get(key);
		if (value === undefined) return env[key];
		if (resolving.has(key)) return ""; // cycle : la référence reste vide
		resolving.add(key);
		const text = value.expand
			? value.text.replace(EXPANSION_RE, (whole, braced, fallback, bare) => {
					if (whole === "\\$") return "$";
					const name = (braced ?? bare) as string;
					const found = resolve(name);
					return found !== undefined && found !== "" ? found : (fallback ?? "");
				})
			: value.text;
		resolving.delete(key);
		resolved.set(key, text);
		return text;
	};
	const out: Record<string, string> = {};
	for (const key of raw.keys()) out[key] = resolve(key) as string;
	return out;
}

function findClosingQuote(body: string, quote: string): number {
	for (let i = 0; i < body.length; i += 1) {
		if (quote === '"' && body[i] === "\\") {
			i += 1;
			continue;
		}
		if (body[i] === quote) return i;
	}
	return -1;
}

function unescapeDoubleQuoted(text: string): string {
	return text.replace(/\\([nrt"\\])/g, (_m, c: string) =>
		c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c
	);
}
