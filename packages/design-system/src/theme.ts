import { createTheme, type MantineColorsTuple } from "@mantine/core";

const slate: MantineColorsTuple = [
	"#f8fafc",
	"#f1f5f9",
	"#e2e8f0",
	"#cbd5e1",
	"#94a3b8",
	"#64748b",
	"#475569",
	"#334155",
	"#1e293b",
	"#0f172a",
];

const blue: MantineColorsTuple = [
	"#eff6ff",
	"#dbeafe",
	"#bfdbfe",
	"#93c5fd",
	"#60a5fa",
	"#3b82f6",
	"#2563eb",
	"#1d4ed8",
	"#1e40af",
	"#1e3a8a",
];

const amber: MantineColorsTuple = [
	"#fffbeb",
	"#fef3c7",
	"#fde68a",
	"#fcd34d",
	"#fbbf24",
	"#f59e0b",
	"#d97706",
	"#b45309",
	"#92400e",
	"#78350f",
];

const emerald: MantineColorsTuple = [
	"#ecfdf5",
	"#d1fae5",
	"#a7f3d0",
	"#6ee7b7",
	"#34d399",
	"#10b981",
	"#059669",
	"#047857",
	"#065f46",
	"#064e3b",
];

const red: MantineColorsTuple = [
	"#fef2f2",
	"#fee2e2",
	"#fecaca",
	"#fca5a5",
	"#f87171",
	"#ef4444",
	"#dc2626",
	"#b91c1c",
	"#991b1b",
	"#7f1d1d",
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

export const theme = createTheme({
	primaryColor: "brand",
	primaryShade: { light: 6, dark: 5 },
	colors: {
		brand: blue,
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
		xs: "0 1px 3px rgba(15,23,42,0.08)",
		sm: "0 2px 6px rgba(15,23,42,0.10)",
		md: "0 4px 16px rgba(15,23,42,0.10)",
		lg: "0 8px 24px rgba(15,23,42,0.12)",
		xl: "0 24px 60px -20px rgba(15,23,42,0.25), 0 2px 6px rgba(15,23,42,0.06)",
	},
	other: {
		frameHues: FRAME_HUES,
		canvasBg: "#eef1f5",
		canvasSurface: "#fafbfc",
	},
});
