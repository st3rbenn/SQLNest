import {
	IconAlertCircle,
	IconCheck,
	IconInfoCircle,
	IconX
} from "@tabler/icons-react";
import type { CSSProperties, ReactNode } from "react";
import type { Notification, NotificationLevel } from "./notifications-context";
import { useNotifications } from "./notifications-context";

/**
 * Rendu de la stack de notifications — monté automatiquement par le
 * Provider. Position fixed top-center, chaque item empilé vertical.
 *
 * `pointer-events: none` sur le wrapper permet aux clics de traverser
 * les zones vides entre notifs (l'user peut interagir avec la page en
 * dessous). Les items eux-mêmes réactivent `pointer-events: auto` pour
 * accepter le clic sur leur bouton dismiss.
 */

const containerStyle: CSSProperties = {
	position: "fixed",
	top: 16,
	left: 0,
	right: 0,
	zIndex: 100,
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	gap: 8,
	pointerEvents: "none"
};

const itemStyle: CSSProperties = {
	display: "flex",
	alignItems: "flex-start",
	gap: 10,
	padding: "10px 12px 10px 14px",
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
	// × 12px = ~19px → offset 2px pour matcher la baseline).
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

const dismissButtonStyle: CSSProperties = {
	flexShrink: 0,
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	width: 20,
	height: 20,
	padding: 0,
	marginTop: -1,
	background: "transparent",
	border: "none",
	borderRadius: 4,
	color: "var(--sqlnest-text-tertiary)",
	cursor: "pointer"
};

const DISMISS_HOVER_CSS = `
.sqlnest-notif-dismiss:hover {
	background: var(--sqlnest-surface-hover) !important;
	color: var(--sqlnest-text-primary) !important;
}
`;

/**
 * Parse un message avec des segments backtickés en text + `<code>`
 * inline. Ex. "Lance \`sqlnest connect\`" → ["Lance ", <code>sqlnest
 * connect</code>].
 */
function parseInlineCode(message: string): ReactNode[] {
	const parts = message.split("`");
	return parts.map((part, i) =>
		i % 2 === 0 ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: split parts stable
			<span key={i}>{part}</span>
		) : (
			// biome-ignore lint/suspicious/noArrayIndexKey: split parts stable
			<code key={i} style={codeChipStyle}>
				{part}
			</code>
		)
	);
}

function defaultIcon(level: NotificationLevel): ReactNode {
	const props = { size: 14, stroke: 2 } as const;
	if (level === "success") return <IconCheck {...props} />;
	if (level === "warning" || level === "error") {
		return <IconAlertCircle {...props} />;
	}
	return <IconInfoCircle {...props} />;
}

function isAssertive(level: NotificationLevel): boolean {
	return level === "warning" || level === "error";
}

function NotificationItem({
	notification,
	onDismiss
}: {
	readonly notification: Notification;
	readonly onDismiss: () => void;
}): React.ReactNode {
	const assertive = isAssertive(notification.level);
	return (
		<div
			role={assertive ? "alert" : "status"}
			aria-live={assertive ? "assertive" : "polite"}
			style={itemStyle}
		>
			<span style={iconWrapperStyle} aria-hidden="true">
				{notification.icon ?? defaultIcon(notification.level)}
			</span>
			<span style={{ flex: 1 }}>{parseInlineCode(notification.message)}</span>
			<button
				type="button"
				onClick={onDismiss}
				aria-label="Fermer la notification"
				className="sqlnest-notif-dismiss"
				style={dismissButtonStyle}
			>
				<IconX size={12} stroke={2} aria-hidden />
			</button>
		</div>
	);
}

export function NotificationsContainer(): React.ReactNode {
	const { notifications, dismiss } = useNotifications();
	if (notifications.length === 0) return null;
	return (
		<div role="region" aria-label="Notifications" style={containerStyle}>
			<style>{DISMISS_HOVER_CSS}</style>
			{notifications.map((n) => (
				<NotificationItem
					key={n.id}
					notification={n}
					onDismiss={() => dismiss(n.id)}
				/>
			))}
		</div>
	);
}
