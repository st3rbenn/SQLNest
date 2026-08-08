/**
 * Route `/team/:teamSlug/canvas/:connId` — canvas d'une db_connection
 * dans la team courante (C.21.5). Miroir de la route legacy
 * `/canvas/:connId` — même component, mais les hooks lisent le team
 * slug depuis le contexte pour appeler les routes team-scoped.
 */

import { notifications } from "@mantine/notifications";
import { IconPlugConnectedX } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useEffect } from "react";
import { useDbConnections } from "../features/db-connections/useDbConnections";
import { pushRecentConnection } from "../features/db-connections/useRecentConnections";
import { SchemaCanvas } from "../features/schema/SchemaCanvas";
import { useSchema } from "../features/schema/useSchema";
import { useCurrentTeamSlug } from "../features/teams/useCurrentTeam";

export const Route = createFileRoute(
	"/_authenticated/team/$teamSlug/canvas/$connId/"
)({
	component: TeamCanvasPage
});

const pageStyle: CSSProperties = {
	position: "relative",
	height: "100vh",
	background: "var(--sqlnest-canvas-bg)",
	overflow: "hidden"
};

function TeamCanvasPage() {
	const { connId } = Route.useParams();
	const teamSlug = useCurrentTeamSlug();
	const { data: connections } = useDbConnections(teamSlug);
	const { data, error } = useSchema(connId, teamSlug);
	const connection = connections?.find((c) => c.id === connId);
	const dbName = connection?.name ?? connId;

	useEffect(() => {
		pushRecentConnection(connId);
	}, [connId]);

	const isUnknown =
		connections !== undefined && !connections.some((c) => c.id === connId);

	// Rendu :
	//   - `data` en cache → SchemaCanvas rend immédiatement (le prefetch
	//     de `useNavigateToCanvas` warm le cache avant de naviguer).
	//   - erreur schema OU connection inconnue → fond canvas rendu, une
	//     notification top-center informe l'user (voir `useCanvasErrorNotif`).
	//   - undefined pur (deep-link sans prefetch, F5) → fond canvas
	//     silencieux, pas de texte intermédiaire.
	useCanvasErrorNotif({ error, isUnknown });

	if (data) {
		return (
			<div style={pageStyle}>
				<SchemaCanvas schema={data} connectionId={connId} dbName={dbName} />
			</div>
		);
	}
	return <div style={pageStyle} />;
}

/**
 * Route error → notification Mantine. Deps primitives (`errorMessage` /
 * `isUnknown`) → l'effet ne re-run que sur changement réel. Cleanup
 * `notifications.hide(id)` automatiquement quand l'erreur disparaît ou
 * change (ou au unmount de la page).
 */
function useCanvasErrorNotif({
	error,
	isUnknown
}: {
	readonly error: Error | null;
	readonly isUnknown: boolean;
}): void {
	const errorMessage = error?.message ?? null;
	useEffect(() => {
		let message: string | null = null;
		if (isUnknown) {
			message = "Cette connection n'existe pas ou n'est plus disponible.";
		} else if (errorMessage !== null) {
			message = errorMessage;
		}
		if (message === null) return;
		const id = notifications.show({
			color: "red",
			message: parseInlineCode(message),
			icon: <IconPlugConnectedX size={14} stroke={2} />,
			autoClose: false,
			withBorder: true
		});
		return () => notifications.hide(id);
	}, [errorMessage, isUnknown]);
}

/**
 * Rend un message texte avec des segments backtickés en `<code>` inline.
 * Le message backend est du texte brut ("Lance `sqlnest connect`…") —
 * sans ce parse l'user voit les backticks bruts. Simple state machine
 * sur split.
 */
function parseInlineCode(message: string): ReactNode[] {
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
					fontSize: 11.5,
					color: "var(--sqlnest-text-title)"
				}}
			>
				{part}
			</code>
		)
	);
}
