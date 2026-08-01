import { UnstyledButton } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { type CSSProperties, useState } from "react";
import { ColorDot } from "../ColorDot/ColorDot";

export type RowItemSize = "sm" | "md";

export interface RowItemProps {
	/** Texte principal (typiquement nom d'une table ou d'un frame). */
	readonly label: string;
	/** Couleur de la pastille — omise si absente (pas de ColorDot). */
	readonly color?: string;
	readonly onClick?: () => void;
	/** Ligne « sélectionnée » : brand-0 bg + borderLeft brand-6 + brand-7 text + 600. */
	readonly active?: boolean;
	readonly title?: string;
	/** `md` (défaut) = 6px/12px, 12.5px. `sm` = 5px/12px, 11px. */
	readonly size?: RowItemSize;
	/** Rendu du label en monospace (utilisé pour les cellules FK dans TableDetails). */
	readonly monospace?: boolean;
	/** Override du padding gauche (utilisé pour l'indentation dans l'arbre). */
	readonly paddingLeft?: number;
}

interface SizeSpec {
	readonly paddingY: number;
	readonly fontSize: number;
	readonly labelFontSize?: number;
}

const SIZES: Record<RowItemSize, SizeSpec> = {
	md: { paddingY: 6, fontSize: 12.5 },
	sm: { paddingY: 5, fontSize: 11, labelFontSize: 10.5 },
};

/**
 * Ligne cliquable partagée — pastille couleur (optionnelle) + label ellipsé +
 * chevron droit. Motif utilisé pour les tables dans l'arbre, la liste des
 * tables d'un frame, et les relations FK dans le drawer table.
 *
 * `active` marque la ligne courante (fond brand-0, borderLeft brand-6). Le
 * hover ajoute un fond très léger via un state React (pas de CSS externe).
 */
export function RowItem({
	label,
	color,
	onClick,
	active = false,
	title,
	size = "md",
	monospace = false,
	paddingLeft,
}: RowItemProps) {
	const [hover, setHover] = useState(false);
	const spec = SIZES[size];

	const pl = paddingLeft ?? 12;
	// Sur dark : accent soft pour la row active (fond bleu translucide + text
	// accent), surface-hover pour le hover (bump imperceptible depuis
	// `#2C2C2C` mais suffisant à donner le retour visuel).
	const bg = active
		? "var(--sqlnest-accent-soft)"
		: hover
			? "var(--sqlnest-surface-hover)"
			: "transparent";

	const buttonStyle: CSSProperties = {
		display: "flex",
		alignItems: "center",
		gap: 8,
		width: "100%",
		padding: `${spec.paddingY}px 12px ${spec.paddingY}px ${pl}px`,
		fontSize: spec.fontSize,
		background: bg,
		borderLeft: `3px solid ${active ? "var(--sqlnest-accent)" : "transparent"}`,
		color: active ? "var(--sqlnest-accent)" : "var(--sqlnest-text-secondary)",
		fontWeight: active ? 600 : 400,
		textAlign: "left",
		transition: "background 100ms ease-out",
	};

	const labelStyle: CSSProperties = {
		flex: 1,
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	};
	if (monospace) {
		labelStyle.fontFamily = "var(--mantine-font-family-monospace)";
		if (spec.labelFontSize !== undefined) {
			labelStyle.fontSize = spec.labelFontSize;
		}
	}

	return (
		<UnstyledButton
			onClick={onClick}
			title={title}
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			style={buttonStyle}
		>
			{color !== undefined ? <ColorDot color={color} size="sm" /> : null}
			<span style={labelStyle}>{label}</span>
			<IconChevronRight
				size={12}
				stroke={2}
				style={{ color: "var(--sqlnest-text-tertiary)", flexShrink: 0 }}
			/>
		</UnstyledButton>
	);
}
