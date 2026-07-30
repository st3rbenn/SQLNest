import {
	ActionIcon,
	type ActionIconProps,
	Box,
	Tooltip,
} from "@mantine/core";
import type { MouseEventHandler, ReactNode } from "react";

export type ToolbarButtonStatus = "warning" | "info" | "danger";

export type ToolbarButtonProps = {
	label: string;
	active?: boolean;
	statusDot?: ToolbarButtonStatus;
	onClick?: MouseEventHandler<HTMLButtonElement>;
	children: ReactNode;
} & Omit<ActionIconProps, "children" | "onClick" | "aria-label">;

const DOT_COLOR: Record<ToolbarButtonStatus, string> = {
	warning: "var(--mantine-color-amber-5)",
	info: "var(--mantine-color-brand-5)",
	danger: "var(--mantine-color-red-5)",
};

export function ToolbarButton({
	label,
	active,
	statusDot,
	onClick,
	children,
	...rest
}: ToolbarButtonProps) {
	return (
		<Tooltip label={label} position="right" withArrow>
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
