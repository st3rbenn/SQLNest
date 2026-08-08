import { IconPlugConnectedX } from "@tabler/icons-react";
import type { CSSProperties, ReactNode } from "react";

/**
 * Toast top-center pour les erreurs de connexion canvas (« Aucun CLI
 * connecté », « Le CLI n'a pas répondu », etc.). Remplace le message
 * pleine page qui bloquait la lecture — ici l'user voit le fond canvas
 * et la notification en surimpression, plus discret.
 *
 * Accessibilité :
 *   - `role="status"` + `aria-live="polite"` — les lecteurs d'écran
 *     lisent le message sans interrompre la navigation en cours.
 *   - Contraste text/bg ≥ 4.5:1 (text-primary #f5f5f5 sur elevated
 *     #3a3a3a = 12.6:1, WCAG AAA).
 *
 * Le message peut contenir des segments backtickés (\`sqlnest connect\`)
 * — parsé en `<code>` inline pour rester lisible.
 */

const wrapperStyle: CSSProperties = {
	position: "fixed",
	top: 16,
	left: "50%",
	transform: "translateX(-50%)",
	zIndex: 100,
	display: "flex",
	alignItems: "flex-start",
	gap: 10,
	padding: "10px 14px",
	background: "var(--sqlnest-elevated)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 8,
	fontSize: 12,
	color: "var(--sqlnest-text-primary)",
	boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",
	maxWidth: "min(560px, calc(100vw - 32px))",
	lineHeight: 1.55,
	pointerEvents: "auto"
};

const iconWrapperStyle: CSSProperties = {
	flexShrink: 0,
	color: "var(--sqlnest-text-secondary)",
	// Aligne l'icône (14px) avec la 1re ligne du texte (lineHeight 1.55
	// × 12px = ~19px → offset 3px pour matcher la baseline).
	marginTop: 2
};

const codeChipStyle: CSSProperties = {
	background: "var(--sqlnest-surface-hover)",
	padding: "1px 5px",
	borderRadius: 3,
	fontFamily: "var(--mantine-font-family-monospace)",
	fontSize: 11.5,
	color: "var(--sqlnest-text-title)"
};

/**
 * Parse un message avec des segments backtickés en un mix de texte et
 * de `<code>`. Simple state machine — split sur backtick pair/impair.
 * Ex. "Lance `sqlnest connect` maintenant" → ["Lance ", <code>sqlnest connect</code>, " maintenant"].
 */
function parseInlineCode(message: string): ReactNode[] {
	const parts = message.split("`");
	return parts.map((part, i) =>
		i % 2 === 0 ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: parts stable per render
			<span key={i}>{part}</span>
		) : (
			// biome-ignore lint/suspicious/noArrayIndexKey: parts stable per render
			<code key={i} style={codeChipStyle}>
				{part}
			</code>
		)
	);
}

export function CanvasToast({
	message
}: {
	readonly message: string;
}): React.ReactNode {
	return (
		<div role="status" aria-live="polite" style={wrapperStyle}>
			<span style={iconWrapperStyle} aria-hidden="true">
				<IconPlugConnectedX size={14} stroke={2} />
			</span>
			<span>{parseInlineCode(message)}</span>
		</div>
	);
}
