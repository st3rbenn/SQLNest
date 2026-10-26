/**
 * Lecture d'un `schema.prisma` ligne à ligne (ADR-037 D6) : blocs, champs,
 * attributs de bloc, à leurs numéros de ligne. Le patcheur ne réécrit que les
 * lignes qu'il touche ; commentaires et mise en forme du reste sont gardés.
 */

export type BlockKind =
	| "model"
	| "enum"
	| "view"
	| "type"
	| "datasource"
	| "generator";

export interface PrismaBlock {
	readonly kind: BlockKind;
	readonly name: string;
	/** Ligne `model X {`. */
	readonly start: number;
	/** Ligne `}`. */
	readonly end: number;
}

export interface PrismaField {
	readonly line: number;
	readonly name: string;
	/** Type sans `?` ni `[]` : `String`, `Agency`, `Unsupported("…")`. */
	readonly type: string;
	readonly optional: boolean;
	readonly list: boolean;
	/** Le reste de la ligne : attributs, commentaire. */
	readonly attributes: string;
}

export interface PrismaSchema {
	readonly lines: readonly string[];
	readonly blocks: readonly PrismaBlock[];
}

const BLOCK_START_RE =
	/^(model|enum|view|type|datasource|generator)\s+(\w+)\s*\{\s*(?:\/\/.*)?$/;
const FIELD_RE =
	/^\s*(\w+)\s+(Unsupported\("(?:[^"\\]|\\.)*"\)|\w+)(\[\])?(\?)?(?:\s+(.*?))?\s*$/;
const MODEL_MAP_RE = /@@map\(\s*(?:name:\s*)?"((?:[^"\\]|\\.)*)"/;
const FIELD_MAP_RE = /(?<!@)@map\(\s*(?:name:\s*)?"((?:[^"\\]|\\.)*)"/;
const PROVIDER_RE = /^\s*provider\s*=\s*"([^"]+)"/;

export function parseSchema(text: string): PrismaSchema {
	const lines = text.split("\n");
	const blocks: PrismaBlock[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		const m = BLOCK_START_RE.exec(lines[i] as string);
		if (m === null) continue;
		let end = i + 1;
		while (end < lines.length && (lines[end] as string).trim() !== "}")
			end += 1;
		blocks.push({
			kind: m[1] as BlockKind,
			name: m[2] as string,
			start: i,
			end
		});
		i = end;
	}
	return { lines, blocks };
}

export function findBlock(
	schema: PrismaSchema,
	kind: BlockKind,
	name: string
): PrismaBlock | undefined {
	return schema.blocks.find((b) => b.kind === kind && b.name === name);
}

/** Champs d'un modèle (lignes hors commentaires et attributs de bloc). */
export function modelFields(
	schema: PrismaSchema,
	block: PrismaBlock
): PrismaField[] {
	const fields: PrismaField[] = [];
	for (let i = block.start + 1; i < block.end; i += 1) {
		const raw = schema.lines[i] as string;
		const trimmed = raw.trim();
		if (
			trimmed === "" ||
			trimmed.startsWith("//") ||
			trimmed.startsWith("@@")
		) {
			continue;
		}
		const field = parseField(raw, i);
		if (field !== undefined) fields.push(field);
	}
	return fields;
}

/** Champ d'une ligne de modèle, `undefined` si la ligne n'en est pas un. */
export function parseField(raw: string, line: number): PrismaField | undefined {
	const m = FIELD_RE.exec(raw);
	if (m === null) return undefined;
	return {
		line,
		name: m[1] as string,
		type: m[2] as string,
		list: m[3] !== undefined,
		optional: m[4] !== undefined,
		attributes: m[5] ?? ""
	};
}

/** Attributs de bloc `@@…` d'un modèle. */
export function blockAttributes(
	schema: PrismaSchema,
	block: PrismaBlock
): { readonly line: number; readonly text: string }[] {
	const out: { line: number; text: string }[] = [];
	for (let i = block.start + 1; i < block.end; i += 1) {
		const trimmed = (schema.lines[i] as string).trim();
		if (trimmed.startsWith("@@")) out.push({ line: i, text: trimmed });
	}
	return out;
}

/** Table d'un modèle : son `@@map`, sinon son nom. */
export function tableOf(schema: PrismaSchema, block: PrismaBlock): string {
	for (const attr of blockAttributes(schema, block)) {
		const m = MODEL_MAP_RE.exec(attr.text);
		if (m !== null) return m[1] as string;
	}
	return block.name;
}

/** Colonne d'un champ : son `@map`, sinon son nom. */
export function columnOf(field: PrismaField): string {
	return FIELD_MAP_RE.exec(field.attributes)?.[1] ?? field.name;
}

/** Modèle qui porte la table `table`. */
export function modelOfTable(
	schema: PrismaSchema,
	table: string
): PrismaBlock | undefined {
	return schema.blocks.find(
		(b) => b.kind === "model" && tableOf(schema, b) === table
	);
}

/** Fournisseur du `datasource` : `postgresql`, `sqlserver`… */
export function providerOf(schema: PrismaSchema): string | undefined {
	const block = schema.blocks.find((b) => b.kind === "datasource");
	if (block === undefined) return undefined;
	for (let i = block.start + 1; i < block.end; i += 1) {
		const m = PROVIDER_RE.exec(schema.lines[i] as string);
		if (m !== null) return m[1] as string;
	}
	return undefined;
}
