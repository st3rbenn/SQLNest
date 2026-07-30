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
	lightness = 60,
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
				color: "#fff",
				fontSize: 11,
				fontWeight: 700,
				letterSpacing: "0.2px",
				boxShadow: "0 2px 6px rgba(15,23,42,0.12)",
				...(style as Record<string, unknown> | undefined),
			}}
			{...rest}
		>
			{text}
		</Box>
	);
}
