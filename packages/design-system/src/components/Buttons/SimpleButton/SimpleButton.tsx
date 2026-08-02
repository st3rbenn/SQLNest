import {
	Button as MantineButton,
	type ButtonProps as MantineButtonProps,
} from "@mantine/core";
import { forwardRef, type ReactNode } from "react";

export type ButtonProps = {
	variant?: "primary" | "secondary" | "danger";
	size?: "xs" | "sm" | "md" | "lg" | "xl";
	onClick?: () => void;
	/** Quand vrai : bouton désactivé, teinte plus claire, curseur `default`.
	 *  Pas de spinner (visuel volontairement discret). */
	loading?: boolean;
	/** Libellé affiché à la place des `children` pendant `loading`. Sans valeur,
	 *  les `children` restent visibles. */
	loadingLabel?: ReactNode;
	/** HTML `type` attribut natif — utile pour `type="submit"` dans les formulaires
	 *  (auth pages, dialogs). Non exposé par MantineButtonProps qui filtre les
	 *  attributs HTML natifs. Default `"button"` côté DOM (comme n'importe quel
	 *  `<button>` sans attribut). */
	type?: "button" | "submit" | "reset";
} & MantineButtonProps;

// Inline `style` (spécificité 1000) supplante les classes `:disabled` de
// Mantine — nécessaire pour garder le bleu clair au lieu du gris désactivé.
const loadingStyle = {
	background: "var(--mantine-color-blue-3)",
	color: "var(--mantine-color-white)",
	cursor: "default",
	opacity: 1,
	borderColor: "transparent",
} as const;

export const SimpleButton = forwardRef<HTMLButtonElement, ButtonProps>(
	(
		{
			variant = "primary",
			size = "md",
			loading = false,
			loadingLabel,
			disabled,
			children,
			style,
			...props
		},
		ref,
	) => {
		const isLoading = loading === true;
		const isDisabled = isLoading || disabled === true;
		return (
			<MantineButton
				ref={ref}
				variant={variant === "primary" ? "filled" : "outline"}
				size={size}
				color={variant === "danger" ? "red" : "blue"}
				disabled={isDisabled}
				data-loading={isLoading || undefined}
				style={{
					...(isLoading ? loadingStyle : {}),
					...(style as React.CSSProperties | undefined),
				}}
				{...props}
			>
				{isLoading && loadingLabel !== undefined ? loadingLabel : children}
			</MantineButton>
		);
	},
);

SimpleButton.displayName = "SimpleButton";
