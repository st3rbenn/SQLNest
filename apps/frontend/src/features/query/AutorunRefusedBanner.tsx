/**
 * AutorunRefusedBanner — banner permanent affiché au-dessus de l'éditeur
 * quand un `?autorun=1` a été refusé par le check unfiltered/raw ([[ADR-023]]
 * D14). Prévient l'user que l'auto-exec a été bloqué ; il doit vérifier la
 * source et lancer manuellement via ⌘⏎.
 *
 * ─── Pourquoi permanent (pas de fadeout auto) ────────────────────────
 * Un banner qui disparaît en 5s laisserait l'user penser que l'auto-exec
 * s'est bien fait. Le refus est un état structurel : la source à
 * l'ouverture est dangereuse, l'user doit prendre une décision consciente.
 * Le seul way out est le bouton × explicite (dismiss local, ne re-arme
 * pas l'auto-exec).
 */

import { ActionIcon } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import type { CSSProperties } from "react";

const bannerStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 10,
	padding: "8px 14px",
	background: "var(--sqlnest-warning-soft)",
	borderBottom: "1px solid var(--sqlnest-warning)",
	color: "var(--sqlnest-text-primary)",
	fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
	fontSize: 13,
	flexShrink: 0
};

const iconStyle: CSSProperties = {
	fontSize: 16,
	lineHeight: 1
};

const textStyle: CSSProperties = {
	flex: 1,
	lineHeight: 1.4
};

const shortcutStyle: CSSProperties = {
	fontFamily: "var(--mantine-font-family-monospace)",
	background: "var(--sqlnest-surface)",
	padding: "1px 5px",
	borderRadius: 4,
	fontSize: 11,
	color: "var(--sqlnest-text-secondary)"
};

export interface AutorunRefusedBannerProps {
	readonly onDismiss: () => void;
}

export function AutorunRefusedBanner({
	onDismiss
}: AutorunRefusedBannerProps): React.ReactNode {
	return (
		<div
			style={bannerStyle}
			role="alert"
			data-testid="autorun-refused-banner"
		>
			<span style={iconStyle}>⚠</span>
			<span style={textStyle}>
				Autorun refusé — la source contient une écriture non filtrée.
				Vérifiez avant d'exécuter manuellement (<span style={shortcutStyle}>Ctrl+⏎</span>).
			</span>
			<ActionIcon
				size="sm"
				variant="subtle"
				color="gray"
				onClick={onDismiss}
				aria-label="Fermer"
				data-testid="autorun-refused-dismiss"
			>
				<IconX size={14} />
			</ActionIcon>
		</div>
	);
}
