import { Paper, type PaperProps } from "@mantine/core";
import type { CSSProperties, ReactNode } from "react";

export type FloatingPanelPosition =
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "bottom-center";

export type FloatingPanelOffset = number | { x?: number; y?: number };

export type FloatingPanelProps = {
	position: FloatingPanelPosition;
	offset?: FloatingPanelOffset;
	children: ReactNode;
} & Omit<PaperProps, "pos">;

const DEFAULT_OFFSET = 12;

function resolveOffset(offset: FloatingPanelOffset | undefined): {
	x: number;
	y: number;
} {
	if (offset === undefined) return { x: DEFAULT_OFFSET, y: DEFAULT_OFFSET };
	if (typeof offset === "number") return { x: offset, y: offset };
	return {
		x: offset.x ?? DEFAULT_OFFSET,
		y: offset.y ?? DEFAULT_OFFSET,
	};
}

function positionStyles(
	position: FloatingPanelPosition,
	offset: FloatingPanelOffset | undefined,
): CSSProperties {
	const { x, y } = resolveOffset(offset);
	switch (position) {
		case "top-left":
			return { top: y, left: x };
		case "top-right":
			return { top: y, right: x };
		case "bottom-left":
			return { bottom: y, left: x };
		case "bottom-right":
			return { bottom: y, right: x };
		case "bottom-center":
			return { bottom: y, left: "50%", transform: "translateX(-50%)" };
	}
}

export function FloatingPanel({
	position,
	offset,
	children,
	style,
	...rest
}: FloatingPanelProps) {
	const style_ = { position: "absolute" as const, ...positionStyles(position, offset), ...(style as CSSProperties | undefined) };
	return (
		<Paper
			radius="lg"
			shadow="md"
			withBorder
			style={style_}
			{...rest}
		>
			{children}
		</Paper>
	);
}
