import {
	ActionIcon,
	type ActionIconProps,
	Box,
	type FloatingPosition,
	Tooltip,
} from "@mantine/core";
import type { MouseEventHandler, ReactNode } from "react";

export type ToolbarButtonStatus = "warning" | "info" | "danger";

export type ToolbarButtonProps = {
	label: string;
	active?: boolean;
	statusDot?: ToolbarButtonStatus;
	tooltipPosition?: FloatingPosition;
	onClick?: MouseEventHandler<HTMLButtonElement>;
	children: ReactNode;
} & Omit<ActionIconProps, "children" | "onClick" | "aria-label">;

const DOT_COLOR: Record<ToolbarButtonStatus, string> = {
	warning: "var(--mantine-color-amber-5)",
	info: "var(--mantine-color-brand-5)",
	danger: "var(--mantine-color-red-5)",
};

// Tooltip compact — plus petit padding + fz, coins doux. Applied via `styles`
// pour ne toucher que ce tooltip-là (pas un override global).
const COMPACT_TOOLTIP_STYLES = {
	tooltip: {
		fontSize: 11,
		padding: "4px 8px",
		borderRadius: 6,
	},
} as const;

export function ToolbarButton({
	label,
	active,
	statusDot,
	tooltipPosition = "top",
	onClick,
	children,
	...rest
}: ToolbarButtonProps) {
	return (
		<Tooltip
			label={label}
			position={tooltipPosition}
			openDelay={200}
			withArrow
			arrowSize={5}
			styles={COMPACT_TOOLTIP_STYLES}
		>
			<Box style={{ position: "relative" }}>
				<ActionIcon
					aria-label={label}
					aria-pressed={active ? true : undefined}
					variant={active ? "light" : "subtle"}
					color={active ? "brand" : "slate"}
					radius={9}
					size={36}
					onClick={onClick}
					{...rest}
				>
					{children}
				</ActionIcon>
				{statusDot ? (
					<Box
						data-testid="toolbar-button-status"
						style={{
							position: "absolute",
							top: 2,
							right: 2,
							width: 6,
							height: 6,
							borderRadius: "50%",
							background: DOT_COLOR[statusDot],
							pointerEvents: "none",
						}}
					/>
				) : null}
			</Box>
		</Tooltip>
	);
}
