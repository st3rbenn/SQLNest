import { createTheme, type MantineColorsTuple } from "@mantine/core";

/**
 * Palette dark-first alignée sur les tokens (voir `tokens.css`).
 *
 * Slate/brand sont générés autour de la surface `#2C2C2C`. Mantine
 * consomme ces tuples pour tous ses composants (Text `c="dimmed"`, Paper,
 * Menu, Tooltip, …). On force le même index pour light et dark parce
 * que nous n'exposons qu'un mode — voir `primaryShade` plus bas.
 */
const slate: MantineColorsTuple = [
	"#ffffff", // 0 — text-primary
	"#f0f0f0",
	"#d9d9d9",
	"#b3b3b3", // 3 — text-secondary
	"#8a8a8a",
	"#7a7a7a", // 5 — text-tertiary
	"#5a5a5a",
	"#444444", // 7 — border
	"#363636", // 8 — surface-hover
	"#2c2c2c", // 9 — surface
];

/**
 * Brand = `#0D99FF`. Shades construits autour pour que Mantine puisse
 * dériver les hover / press states.
 */
const brand: MantineColorsTuple = [
	"#e6f5ff",
	"#cceaff",
	"#99d5ff",
	"#66c0ff",
	"#3aabff", // hover
	"#0d99ff", // 5 — accent
	"#0b85e0",
	"#0971bf",
	"#075c9f",
	"#04487f",
];

/**
 * Amber = `#FFC933`. Utilisé pour les PK badges + les tags
 * « bientôt disponible » côté notifications.
 */
const amber: MantineColorsTuple = [
	"#fff8e0",
	"#fff0b8",
	"#ffe485",
	"#ffd85c",
	"#ffce42",
	"#ffc933", // 5 — warning
	"#d9aa2b",
	"#b38c23",
	"#8c6e1b",
	"#665013",
];

/** Emerald = success (statut live). Dark-tuned pour rester lisible sur `#2C2C2C`. */
const emerald: MantineColorsTuple = [
	"#e6fbf3",
	"#c8f5e2",
	"#8be8bd",
	"#4ddb99",
	"#22cc7e",
	"#10b981", // 5 — success
	"#0e9c6d",
	"#0b7e58",
	"#086144",
	"#054530",
];

/** Red = danger (erreurs de requête, actions destructives). */
const red: MantineColorsTuple = [
	"#fdecec",
	"#fbd0d0",
	"#f8a5a5",
	"#f47a7a",
	"#f14f4f",
	"#ef4444", // 5 — danger
	"#cc3939",
	"#a82f2f",
	"#852525",
	"#621b1b",
];

// Hues used by frames + table headers on the canvas (mockup 1a).
export const FRAME_HUES = {
	users: 210,
	commerce: 30,
	analytics: 262,
	crossrefs: 340,
	events: 275,
	xref: 155,
} as const;

export type FrameHueKey = keyof typeof FRAME_HUES;

/**
 * Thème Mantine — dark-only. `primaryShade` figé à 5 pour light et dark :
 * nous n'exposons pas de toggle, mais Mantine peut demander le shade en
 * interne (SegmentedControl, focus rings…). Aligner évite les variations
 * dépendantes du mode calculé.
 */
export const theme = createTheme({
	primaryColor: "brand",
	primaryShade: { light: 5, dark: 5 },
	colors: {
		brand,
		slate,
		amber,
		emerald,
		red,
	},
	defaultRadius: "md",
	radius: {
		xs: "6px",
		sm: "8px",
		md: "10px",
		lg: "12px",
		xl: "14px",
	},
	fontFamily:
		"'Inter', ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
	fontFamilyMonospace:
		"'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
	headings: {
		fontFamily:
			"'Inter', ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
		fontWeight: "700",
	},
	shadows: {
		xs: "0 1px 3px rgba(0,0,0,0.24)",
		sm: "0 2px 6px rgba(0,0,0,0.28)",
		md: "0 4px 16px rgba(0,0,0,0.32)",
		lg: "0 8px 24px rgba(0,0,0,0.4)",
		xl: "0 24px 60px -20px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.3)",
	},
	other: {
		frameHues: FRAME_HUES,
		canvasBg: "#1E1E1E",
		canvasSurface: "#2C2C2C",
	},
});
