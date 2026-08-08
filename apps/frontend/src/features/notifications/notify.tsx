import { notifications } from "@mantine/notifications";
import type { ReactNode } from "react";

/**
 * Helpers centralisés pour push une notification Mantine avec les
 * defaults visuels SQLNest (compact, sans icon, autoClose 5s).
 *
 * `<Notifications position="top-center" />` est monté dans
 * `DesignSystemProvider`. Import direct :
 *   `import { notifyError } from "../notifications/notify"`
 */

/** Auto-dismiss après 5s — assez long pour être lu, assez court pour
 *  ne pas encombrer si l'user ignore. */
const AUTO_CLOSE_MS = 5000;

/** Override compact du style Mantine : padding réduit, texte 11.5px,
 *  bouton close 18px. Pas d'icon (`icon` prop non passé). */
const COMPACT_STYLES = {
	root: {
		padding: "8px 12px",
		minHeight: "auto"
	},
	body: {
		padding: 0,
		margin: 0
	},
	description: {
		fontSize: 11.5,
		lineHeight: 1.5,
		color: "var(--sqlnest-text-primary)"
	},
	closeButton: {
		width: 18,
		height: 18,
		minHeight: 18
	}
} as const;

/**
 * Parse un message avec des segments backtickés en `<code>` inline. Le
 * message backend est du texte brut ("Lance `sqlnest connect`…") — sans
 * ce parse l'user voit les backticks bruts.
 */
export function parseInlineCode(message: string): ReactNode[] {
	const parts = message.split("`");
	return parts.map((part, i) =>
		i % 2 === 0 ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: parts stable per split
			<span key={i}>{part}</span>
		) : (
			<code
				// biome-ignore lint/suspicious/noArrayIndexKey: parts stable per split
				key={i}
				style={{
					background: "var(--sqlnest-surface-hover)",
					padding: "1px 5px",
					borderRadius: 3,
					fontFamily: "var(--mantine-font-family-monospace)",
					fontSize: 11,
					color: "var(--sqlnest-text-title)"
				}}
			>
				{part}
			</code>
		)
	);
}

/**
 * Notification d'erreur — accent rouge (bord gauche Mantine), compact,
 * sans icon, auto-hide 5s. Retourne l'id pour dismiss manuel via
 * `notifications.hide(id)`.
 */
export function notifyError(message: string): string {
	return notifications.show({
		color: "red",
		message: parseInlineCode(message),
		autoClose: AUTO_CLOSE_MS,
		withBorder: false,
		styles: COMPACT_STYLES
	});
}
