import { notifications } from "@mantine/notifications";
import type { ReactNode } from "react";

/**
 * Helpers centralisés pour push une notification Mantine avec les
 * defaults visuels SQLNest (compact, sans icon, auto-hide 5s, sans
 * bande de couleur à gauche).
 *
 * `<Notifications position="top-center" limit={2} />` est monté dans
 * `DesignSystemProvider`. Import direct :
 *   `import { notifyError } from "../notifications/notify"`
 */

/** Auto-dismiss après 5s — assez long pour être lu, assez court pour
 *  ne pas encombrer si l'user ignore. */
const AUTO_CLOSE_MS = 5000;

/** Override compact du style Mantine : padding réduit, texte 11.5px,
 *  bouton close 18px. La bande de couleur à gauche (`::before`) est kill
 *  via la classe `.sqlnest-notification` dans `tokens.css` — le `styles`
 *  prop de Mantine ne supporte pas les pseudo-elements. */
const COMPACT_STYLES = {
	root: {
		padding: "8px 12px",
		minHeight: "auto",
		// Border rouge sobre — signale erreur sans crier. Override le
		// border neutre appliqué par Mantine (avec `withBorder: false`
		// aucun border n'est ajouté par Mantine, on met le nôtre ici).
		border: "1px solid var(--sqlnest-danger-border)"
	},
	body: {
		padding: 0,
		margin: 0
	},
	description: {
		fontSize: 11,
		lineHeight: 1.5,
		color: "var(--sqlnest-text-primary)"
	},
	closeButton: {
		width: 18,
		height: 18,
		minHeight: 18
	}
} as const;

const COMPACT_CLASSNAMES = {
	root: "sqlnest-notification"
} as const;

const codeChipStyle = {
	background: "var(--sqlnest-surface-hover)",
	padding: "1px 5px",
	borderRadius: 3,
	fontFamily: "var(--mantine-font-family-monospace)",
	fontSize: 10.5,
	color: "var(--sqlnest-text-title)"
} as const;

/**
 * Rend une seule phrase — parse les backticks (`code`) en `<code>` chip
 * inline. Simple state machine sur split.
 */
function renderSentence(sentence: string): ReactNode[] {
	const parts = sentence.split("`");
	return parts.map((part, i) =>
		i % 2 === 0 ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: parts stable per split
			<span key={i}>{part}</span>
		) : (
			// biome-ignore lint/suspicious/noArrayIndexKey: parts stable per split
			<code key={i} style={codeChipStyle}>
				{part}
			</code>
		)
	);
}

/**
 * Split le message par phrases (`. ` ou `.\n`) puis rend chaque phrase
 * sur sa propre ligne. Wrap si trop long. Résout le cas messages backend
 * multi-phrases genre « Aucun CLI. Lance `sqlnest connect` » qui
 * s'entassaient sur des lignes coupées de façon peu lisible.
 */
function renderMessage(message: string): ReactNode {
	const sentences = message
		.split(/(?<=\.)\s+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return sentences.map((s, i) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: sentences stable per split
		<div key={i}>{renderSentence(s)}</div>
	));
}

/**
 * Notification d'erreur — compact, sans icon, sans bande de couleur,
 * auto-hide 5s. Retourne l'id pour dismiss manuel via `notifications.hide(id)`.
 */
export function notifyError(message: string): string {
	return notifications.show({
		message: renderMessage(message),
		autoClose: AUTO_CLOSE_MS,
		withBorder: false,
		styles: COMPACT_STYLES,
		classNames: COMPACT_CLASSNAMES
	});
}
