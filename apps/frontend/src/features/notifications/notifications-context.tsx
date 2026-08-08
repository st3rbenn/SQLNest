import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState
} from "react";
import { NotificationsContainer } from "./NotificationsContainer";

/**
 * Notifications center — Provider global monté dans `_authenticated.tsx`,
 * exposé via `useNotifications()`. N'importe quelle page (gallery, canvas,
 * pair, …) peut push une notification :
 *
 *   const { show, dismiss } = useNotifications()
 *   useEffect(() => {
 *     if (!error) return
 *     const id = show({ level: "error", message: error.message })
 *     return () => dismiss(id)
 *   }, [error, show, dismiss])
 *
 * Rendu : stack top-center dans `NotificationsContainer`. Accessible :
 * `role="region" aria-label="Notifications"` sur le container, chaque
 * item est `role="status"` (info/success) ou `role="alert"` (warn/error).
 */

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface NotificationInput {
	readonly level: NotificationLevel;
	/** Message texte — supporte les backticks (`code`) rendus inline. */
	readonly message: string;
	/** Icon override — sinon icon défaut par level (via `NotificationItem`). */
	readonly icon?: ReactNode;
}

export interface Notification extends NotificationInput {
	readonly id: string;
}

export interface NotificationsAPI {
	readonly notifications: readonly Notification[];
	/** Push une notification, renvoie son id pour dismiss ultérieur. */
	readonly show: (input: NotificationInput) => string;
	readonly dismiss: (id: string) => void;
	readonly dismissAll: () => void;
}

const NotificationsContext = createContext<NotificationsAPI | null>(null);

/** Consomme le context. Throws si utilisé hors Provider — mieux qu'un
 *  fallback silencieux qui masquerait un bug de tree. */
export function useNotifications(): NotificationsAPI {
	const ctx = useContext(NotificationsContext);
	if (ctx === null) {
		throw new Error(
			"useNotifications() must be used inside <NotificationsProvider>"
		);
	}
	return ctx;
}

function nextId(): string {
	// `crypto.randomUUID` est dispo dans tous les browsers modernes + Node
	// 19+, largement suffisant pour l'ID d'une notif (pas de collision
	// possible même à haut débit).
	return typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `notif-${Math.random().toString(36).slice(2)}`;
}

export function NotificationsProvider({
	children
}: {
	readonly children: ReactNode;
}): React.ReactNode {
	const [notifications, setNotifications] = useState<readonly Notification[]>(
		[]
	);

	const show = useCallback((input: NotificationInput): string => {
		const id = nextId();
		setNotifications((prev) => [...prev, { ...input, id }]);
		return id;
	}, []);

	const dismiss = useCallback((id: string) => {
		setNotifications((prev) => prev.filter((n) => n.id !== id));
	}, []);

	const dismissAll = useCallback(() => {
		setNotifications([]);
	}, []);

	const api = useMemo<NotificationsAPI>(
		() => ({ notifications, show, dismiss, dismissAll }),
		[notifications, show, dismiss, dismissAll]
	);

	return (
		<NotificationsContext.Provider value={api}>
			{children}
			<NotificationsContainer />
		</NotificationsContext.Provider>
	);
}
