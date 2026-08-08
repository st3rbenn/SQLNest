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

const emptyStyle: CSSProperties = {
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

	// Rendu :
	//   - `data` en cache → SchemaCanvas rend immédiatement (le prefetch
	//     de `useNavigateToCanvas` warm le cache avant de naviguer).
	//   - erreur schema OU connection inconnue → message d'erreur, mais
	//     PAS de "Loading…" — la nav ne se déclenche que quand data est
	//     prête (voir Promise.allSettled dans useNavigateToCanvas).
	//   - undefined pur (deep-link sans prefetch, F5) → fond canvas
	//     silencieux, pas de texte intermédiaire.
	if (data) {
		return (
			<div style={pageStyle}>
				<SchemaCanvas schema={data} connectionId={connId} dbName={dbName} />
			</div>
		);
	}
	if (isUnknown) {
		return (
			<div style={pageStyle}>
				<div style={emptyStyle}>
					Cette connection n'existe pas ou n'est plus disponible.
				</div>
			</div>
		);
	}
	if (error) {
		return (
			<div style={pageStyle}>
				<div style={emptyStyle}>{error.message}</div>
			</div>
		);
	}
	return <div style={pageStyle} />;
}
