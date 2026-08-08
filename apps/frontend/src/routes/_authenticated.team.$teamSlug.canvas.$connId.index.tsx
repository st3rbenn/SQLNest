/**
 * Route `/team/:teamSlug/canvas/:connId` — canvas d'une db_connection
 * dans la team courante (C.21.5). Miroir de la route legacy
 * `/canvas/:connId` — même component, mais les hooks lisent le team
 * slug depuis le contexte pour appeler les routes team-scoped.
 */

import { createFileRoute } from "@tanstack/react-router";
import { type CSSProperties, useEffect } from "react";
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

const loadingStyle: CSSProperties = {
	position: "absolute",
	inset: 0,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	fontSize: 12,
	color: "var(--sqlnest-text-tertiary)"
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

	return (
		<div style={pageStyle}>
			{data ? (
				<SchemaCanvas schema={data} connectionId={connId} dbName={dbName} />
			) : (
				<div style={loadingStyle}>
					{isUnknown
						? "Cette connection n'existe pas ou n'est plus disponible."
						: error
							? error.message
							: "Introspection…"}
				</div>
			)}
		</div>
	);
}
