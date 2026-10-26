/**
 * Modifications ligne à ligne d'un `schema.prisma`. Le fichier est relu
 * après chaque modification ; à la fin, seuls les blocs touchés sont remis
 * en ordre (lignes vides doublées, en tête ou en fin de bloc).
 */

import {
	type PrismaBlock,
	type PrismaSchema,
	parseSchema
} from "./schema-file";

const INDENT_RE = /^(\s+)\w/;
const DEFAULT_INDENT = "  ";

export class SchemaEditor {
	private readonly lines: string[];
	private readonly touched = new Set<string>();

	constructor(text: string) {
		this.lines = text.split("\n");
	}

	get schema(): PrismaSchema {
		return parseSchema(this.lines.join("\n"));
	}

	/** Indentation des champs du fichier. */
	get indent(): string {
		const schema = this.schema;
		for (const block of schema.blocks) {
			if (block.kind !== "model" && block.kind !== "enum") continue;
			for (let i = block.start + 1; i < block.end; i += 1) {
				const m = INDENT_RE.exec(this.lines[i] as string);
				if (m !== null) return m[1] as string;
			}
		}
		return DEFAULT_INDENT;
	}

	line(index: number): string {
		return this.lines[index] ?? "";
	}

	replace(index: number, text: string, block: PrismaBlock): void {
		this.lines[index] = text;
		this.touch(block);
	}

	/** Lignes insérées avant `index`. */
	insert(index: number, texts: readonly string[], block: PrismaBlock): void {
		this.lines.splice(index, 0, ...texts);
		this.touch(block);
	}

	/** Lignes d'une même lecture du fichier, retirées ensemble. */
	remove(indexes: Iterable<number>, blocks: readonly PrismaBlock[]): void {
		const sorted = [...new Set(indexes)].sort((a, b) => b - a);
		for (const index of sorted) this.lines.splice(index, 1);
		for (const block of blocks) this.touch(block);
	}

	/** Bloc ajouté après `after` (à la fin sans lui), séparé par une ligne vide. */
	insertBlock(texts: readonly string[], after: PrismaBlock | undefined): void {
		let at = after !== undefined ? after.end + 1 : this.lines.length;
		if (after === undefined) {
			while (at > 0 && this.line(at - 1).trim() === "") at -= 1;
		}
		const next = this.lines[at];
		const separator = next !== undefined && next.trim() !== "" ? [""] : [];
		this.lines.splice(at, 0, "", ...texts, ...separator);
	}

	/** Bloc retiré avec la ligne vide qui le séparait du précédent. */
	removeBlock(block: PrismaBlock): void {
		const before = block.start > 0 && this.line(block.start - 1).trim() === "";
		const after = this.line(block.end + 1).trim() === "";
		const from = before ? block.start - 1 : block.start;
		const to = !before && after ? block.end + 1 : block.end;
		this.lines.splice(from, to - from + 1);
		this.touched.delete(key(block));
	}

	touch(block: PrismaBlock): void {
		this.touched.add(key(block));
	}

	text(): string {
		const schema = this.schema;
		const blocks = schema.blocks
			.filter((b) => this.touched.has(key(b)))
			.sort((a, b) => b.start - a.start);
		for (const block of blocks) this.tidy(block);
		return this.lines.join("\n");
	}

	private tidy(block: PrismaBlock): void {
		const inner = this.lines.slice(block.start + 1, block.end);
		const kept: string[] = [];
		for (const line of inner) {
			const blank = line.trim() === "";
			if (
				blank &&
				(kept.length === 0 || (kept.at(-1) as string).trim() === "")
			) {
				continue;
			}
			kept.push(blank ? "" : line);
		}
		while (kept.length > 0 && (kept.at(-1) as string) === "") kept.pop();
		this.lines.splice(block.start + 1, inner.length, ...kept);
	}
}

function key(block: PrismaBlock): string {
	return `${block.kind} ${block.name}`;
}
