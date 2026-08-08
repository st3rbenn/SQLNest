/**
 * Route `/team/:teamSlug/canvas/:connId` — canvas d'une db_connection
 * dans la team courante (C.21.5). Miroir de la route legacy
 * `/canvas/:connId` — même component, mais les hooks lisent le team
 * slug depuis le contexte pour appeler les routes team-scoped.
 */

import { IconPlugConnectedX } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { type CSSProperties, useEffect } from "react";
import { useDbConnections } from "../features/db-connections/useDbConnections";
import { pushRecentConnection } from "../features/db-connections/useRecentConnections";
import { useNotifications } from "../features/notifications/notifications-context";
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
 * Route error → notification. Dependencies primitives (`errorMessage` /
 * `isUnknown`) → l'effet ne re-run que sur changement réel. Cleanup
 * dismiss automatiquement quand l'erreur disparaît ou change.
 */
function useCanvasErrorNotif({
	error,
	isUnknown
}: {
	readonly error: Error | null;
	readonly isUnknown: boolean;
}): void {
	const { show, dismiss } = useNotifications();
	const errorMessage = error?.message ?? null;
	useEffect(() => {
		let message: string | null = null;
		if (isUnknown) {
			message = "Cette connection n'existe pas ou n'est plus disponible.";
		} else if (errorMessage !== null) {
			message = errorMessage;
		}
		if (message === null) return;
		const id = show({
			level: "error",
			message,
			icon: <IconPlugConnectedX size={14} stroke={2} />
		});
		return () => dismiss(id);
	}, [errorMessage, isUnknown, show, dismiss]);
}
