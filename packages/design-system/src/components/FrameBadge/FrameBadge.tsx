import { Box, type BoxProps } from "@mantine/core";

export type FrameBadgeProps = {
	hue: number;
	label: string;
	count?: number;
	saturation?: number;
	lightness?: number;
} & Omit<BoxProps, "children">;

export function FrameBadge({
	hue,
	label,
	count,
	saturation = 55,
	// Lightness abaissée à 45 (au lieu de 60) pour rester lisible sur bg dark
	// tout en gardant un texte blanc au-dessus (contraste ≥ 4.5:1).
	lightness = 45,
	style,
	...rest
}: FrameBadgeProps) {
	const text = count === undefined ? label : `${label} · ${count}`;
	return (
		<Box
			style={{
				display: "inline-flex",
				alignItems: "center",
				padding: "3px 10px",
				borderRadius: 6,
				background: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
				color: "var(--sqlnest-text-primary)",
				fontSize: 11,
				fontWeight: 700,
				letterSpacing: "0.2px",
				boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
				...(style as Record<string, unknown> | undefined),
			}}
			{...rest}
		>
			{text}
		</Box>
	);
}
