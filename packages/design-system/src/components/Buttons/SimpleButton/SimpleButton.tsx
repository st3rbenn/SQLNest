import { forwardRef } from "react";
import {
	Button as MantineButton,
	type ButtonProps as MantineButtonProps,
} from "@mantine/core";

export type ButtonProps = {
	variant?: "primary" | "secondary" | "danger";
	size?: "xs" | "sm" | "md" | "lg" | "xl";
	onClick?: () => void;
} & MantineButtonProps;

export const SimpleButton = forwardRef<HTMLButtonElement, ButtonProps>(
	({ variant = "primary", size = "md", ...props }, ref) => {
		return (
			<MantineButton
				ref={ref}
				variant={variant === "primary" ? "filled" : "outline"}
				size={size}
				color={variant === "danger" ? "red" : "blue"}
				{...props}
			/>
		);
	},
);

SimpleButton.displayName = "SimpleButton";
