import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Garde-fou des tokens : le frontend et le design system ne posent ni taille
 * de police ni rayon en dur, n'utilisent que des tokens définis, et n'ajoutent
 * pas de couleur en dur.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const ROOTS = ["apps/frontend/src", "packages/design-system/src"];
/** Là où les valeurs se définissent. */
const DEFINITIONS = new Set(["tokens.css", "theme.ts"]);
const SOURCE = /\.(ts|tsx|css)$/;
const NOT_SOURCE = /\.(test|stories)\.|\.gen\.ts$/;

/**
 * Couleurs en dur déjà présentes, par fichier. Le nombre ne peut que baisser :
 * une couleur de plus, ou un fichier de plus, fait échouer le test.
 */
const HEX_BASELINE: Readonly<Record<string, number>> = {
	"apps/frontend/src/features/query/snql-language.ts": 6,
	"apps/frontend/src/features/schema/TableNode.tsx": 2,
	"apps/frontend/src/features/schema/relation-inference/RelationInferenceLayer.tsx": 2,
	"apps/frontend/src/features/schema/canvas/relationEdge.ts": 2,
	"apps/frontend/src/features/schema/canvas/CanvasBreadcrumb.tsx": 2,
	"apps/frontend/src/features/gallery/GalleryPage.tsx": 1,
	"apps/frontend/src/features/schema/nodes/SystemNodeShell.tsx": 1,
	"apps/frontend/src/features/schema/canvas/useCanvasEdges.ts": 1,
	"apps/frontend/src/features/checksum-history/UnseenEventsBadge.tsx": 1
};
const RGB_BASELINE: Readonly<Record<string, number>> = {
	"apps/frontend/src/features/schema/TableNode.tsx": 5,
	"packages/design-system/src/components/ContextMenu/ContextMenu.tsx": 4,
	"apps/frontend/src/features/schema/edges/EdgeTooltip.tsx": 3,
	"apps/frontend/src/features/query/SnqlEditor.tsx": 3,
	"apps/frontend/src/features/schema/canvas-overrides.css": 2,
	"apps/frontend/src/features/schema/nodes/SystemNodeShell.tsx": 2,
	"apps/frontend/src/features/auth/UserBadge.tsx": 1,
	"apps/frontend/src/features/schema/SchemaCanvas.tsx": 1,
	"apps/frontend/src/features/schema/nodes/ConsoleNode.tsx": 1,
	"apps/frontend/src/features/schema/edges/EdgeHandles.tsx": 1,
	"apps/frontend/src/features/checksum-history/UnseenEventsBadge.tsx": 1,
	"apps/frontend/src/features/teams/TeamSelector.tsx": 1,
	"apps/frontend/src/features/notifications/notify.tsx": 1,
	"apps/frontend/src/routes/_auth.tsx": 1,
	"packages/design-system/src/components/FrameBadge/FrameBadge.tsx": 1
};

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|[^:"'])\/\/[^\n]*/g;
const TOKEN_DEFINITION = /(--sqlnest-[a-z0-9-]+)\s*:/g;
const TOKEN_USE = /var\((--sqlnest-[a-z0-9-]+)/g;
const HEX_COLOR = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z])/g;
const RGB_COLOR = /\brgba?\(/g;
/** L'attribut SVG `fontSize={…}` n'est pas visé : il s'exprime en unités du viewBox. */
const FONT_SIZE = /fontSize:\s*"?\d|font-size:\s*\d/g;
/** `0` et `50%` restent permis : absence de rayon, cercle parfait. */
const RADIUS =
	/borderRadius:\s*[1-9]|borderRadius:\s*"\d+px|\bradius=\{\d|border-radius:\s*[1-9]/g;

interface SourceFile {
	readonly path: string;
	readonly code: string;
}

function walk(dir: string, out: string[]): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			if (name !== "generated" && name !== "node_modules") walk(full, out);
		} else if (
			SOURCE.test(name) &&
			!NOT_SOURCE.test(name) &&
			!DEFINITIONS.has(name)
		) {
			out.push(full);
		}
	}
	return out;
}

const files: readonly SourceFile[] = ROOTS.flatMap((root) =>
	walk(join(REPO, root), [])
).map((full) => ({
	path: relative(REPO, full).split("\\").join("/"),
	code: readFileSync(full, "utf8")
		.replace(BLOCK_COMMENT, "")
		.replace(LINE_COMMENT, "$1")
}));

function count(code: string, pattern: RegExp): number {
	return code.match(pattern)?.length ?? 0;
}

function filesWith(pattern: RegExp): string[] {
	return files.filter((f) => count(f.code, pattern) > 0).map((f) => f.path);
}

/** Fichiers qui dépassent leur plafond, sous la forme `chemin : n (plafond m)`. */
function overBaseline(
	pattern: RegExp,
	baseline: Readonly<Record<string, number>>
): string[] {
	return files.flatMap((f) => {
		const found = count(f.code, pattern);
		const allowed = baseline[f.path] ?? 0;
		return found > allowed ? [`${f.path} : ${found} (plafond ${allowed})`] : [];
	});
}

describe("tokens — garde-fou", () => {
	it("trouve des fichiers à contrôler", () => {
		expect(files.length).toBeGreaterThan(100);
	});

	it("tout token `--sqlnest-*` utilisé est défini dans tokens.css", () => {
		const defined = new Set(
			[
				...readFileSync(join(HERE, "tokens.css"), "utf8").matchAll(
					TOKEN_DEFINITION
				)
			].map((m) => m[1])
		);
		const unknown = files.flatMap((f) =>
			[...f.code.matchAll(TOKEN_USE)]
				.map((m) => m[1])
				.filter((name) => !defined.has(name))
				.map((name) => `${f.path} : ${name}`)
		);
		expect(unknown).toEqual([]);
	});

	it("aucune taille de police en dur : `--sqlnest-font-size-*`", () => {
		expect(filesWith(FONT_SIZE)).toEqual([]);
	});

	it("aucun rayon en dur : `--sqlnest-radius-*`", () => {
		expect(filesWith(RADIUS)).toEqual([]);
	});

	it("aucune couleur hexadécimale de plus", () => {
		expect(overBaseline(HEX_COLOR, HEX_BASELINE)).toEqual([]);
	});

	it("aucune couleur rgb()/rgba() de plus", () => {
		expect(overBaseline(RGB_COLOR, RGB_BASELINE)).toEqual([]);
	});
});
