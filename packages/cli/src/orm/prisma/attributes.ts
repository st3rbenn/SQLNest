/**
 * Attributs d'une ligne de `schema.prisma` (`@id`, `@default(now())`,
 * `@relation("…", fields: [a], references: [id])`, `@@index([a, b])`) et
 * leurs arguments, lus et réécrits sans toucher au reste de la ligne.
 */

export interface PrismaAttribute {
	/** `@id`, `@db.Uuid`, `@@index`. */
	readonly name: string;
	/** Texte entre parenthèses ; absent sans parenthèses. */
	readonly args?: string;
}

export interface AttributeLine {
	readonly attributes: readonly PrismaAttribute[];
	/** Fin de ligne gardée telle quelle : un commentaire. */
	readonly tail: string;
}

export interface PrismaArgument {
	/** Absent pour un argument positionnel. */
	readonly key?: string;
	readonly value: string;
}

const ATTRIBUTE_NAME_RE = /^@@?[A-Za-z_][\w.]*/;
const NAMED_ARGUMENT_RE = /^([A-Za-z_]\w*)\s*:\s*([\s\S]*)$/;
const LEADING_IDENT_RE = /^\s*(\w+)/;
const LIST_BRACKETS_RE = /^\[|\]$/g;

export function parseAttributes(text: string): AttributeLine {
	const attributes: PrismaAttribute[] = [];
	let i = 0;
	while (i < text.length) {
		if (text[i] === " " || text[i] === "\t") {
			i += 1;
			continue;
		}
		const name =
			text[i] === "@" ? ATTRIBUTE_NAME_RE.exec(text.slice(i))?.[0] : undefined;
		if (name === undefined) break;
		const open = i + name.length;
		if (text[open] !== "(") {
			attributes.push({ name });
			i = open;
			continue;
		}
		const close = closingParen(text, open);
		if (close === -1) break;
		attributes.push({ name, args: text.slice(open + 1, close) });
		i = close + 1;
	}
	return { attributes, tail: text.slice(i).trim() };
}

export function renderAttribute(attribute: PrismaAttribute): string {
	return attribute.args === undefined
		? attribute.name
		: `${attribute.name}(${attribute.args})`;
}

export function renderAttributes(line: AttributeLine): string {
	return [
		...line.attributes.map(renderAttribute),
		...(line.tail !== "" ? [line.tail] : [])
	].join(" ");
}

export function parseArguments(args: string): PrismaArgument[] {
	return splitTopLevel(args)
		.map((part) => part.trim())
		.filter((part) => part !== "")
		.map((part) => {
			const m = NAMED_ARGUMENT_RE.exec(part);
			return m !== null
				? { key: m[1] as string, value: (m[2] as string).trim() }
				: { value: part };
		});
}

export function renderArguments(args: readonly PrismaArgument[]): string {
	return args
		.map((a) => (a.key !== undefined ? `${a.key}: ${a.value}` : a.value))
		.join(", ");
}

export function argument(
	args: readonly PrismaArgument[],
	key: string
): string | undefined {
	return args.find((a) => a.key === key)?.value;
}

/** Argument nommé posé (à sa place, sinon à la fin) ou retiré (`undefined`). */
export function withArgument(
	args: readonly PrismaArgument[],
	key: string,
	value: string | undefined
): PrismaArgument[] {
	if (value === undefined) return args.filter((a) => a.key !== key);
	return args.some((a) => a.key === key)
		? args.map((a) => (a.key === key ? { key, value } : a))
		: [...args, { key, value }];
}

/** `[a, b(sort: Desc)]` → `["a", "b"]`. */
export function fieldList(value: string): string[] {
	const inner = value.trim().replace(LIST_BRACKETS_RE, "");
	return splitTopLevel(inner)
		.map((item) => LEADING_IDENT_RE.exec(item)?.[1])
		.filter((name): name is string => name !== undefined);
}

/** Renomme un champ dans une liste `[…]`, ses arguments (`sort:`) gardés. */
export function renameInFieldList(
	value: string,
	from: string,
	to: string
): string {
	const inner = value.trim().replace(LIST_BRACKETS_RE, "");
	const items = splitTopLevel(inner).map((item) => {
		const trimmed = item.trim();
		const name = LEADING_IDENT_RE.exec(trimmed)?.[1];
		return name === from ? to + trimmed.slice(name.length) : trimmed;
	});
	return `[${items.join(", ")}]`;
}

/** Valeur d'une chaîne Prisma `"…"`, sinon `undefined`. */
export function stringValue(value: string | undefined): string | undefined {
	if (value === undefined || !value.startsWith('"')) return undefined;
	try {
		return JSON.parse(value) as string;
	} catch {
		return undefined;
	}
}

export function quote(value: string): string {
	return JSON.stringify(value);
}

/** Index de la `)` qui ferme la `(` en `open`, chaînes comprises ; -1 sinon. */
function closingParen(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i += 1) {
		const c = text[i];
		if (c === '"') {
			i = closingQuote(text, i);
			if (i === -1) return -1;
		} else if (c === "(") {
			depth += 1;
		} else if (c === ")") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function closingQuote(text: string, open: number): number {
	for (let i = open + 1; i < text.length; i += 1) {
		if (text[i] === "\\") i += 1;
		else if (text[i] === '"') return i;
	}
	return -1;
}

/** Découpe aux virgules de premier niveau (hors chaînes, `()`, `[]`, `{}`). */
function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i += 1) {
		const c = text[i];
		if (c === '"') {
			const end = closingQuote(text, i);
			if (end === -1) break;
			i = end;
		} else if (c === "(" || c === "[" || c === "{") {
			depth += 1;
		} else if (c === ")" || c === "]" || c === "}") {
			depth -= 1;
		} else if (c === "," && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}
