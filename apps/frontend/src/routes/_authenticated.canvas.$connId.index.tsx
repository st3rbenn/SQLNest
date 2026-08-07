import { createFileRoute } from "@tanstack/react-router";
import { type CSSProperties, useEffect } from "react";
import { useDbConnections } from "../features/db-connections/useDbConnections";
import { pushRecentConnection } from "../features/db-connections/useRecentConnections";
import { SchemaCanvas } from "../features/schema/SchemaCanvas";
import { useSchema } from "../features/schema/useSchema";

/**
 * Route `/canvas/$connId` — canvas Schéma d'une db_connection donnée.
 *
 * `$connId` est un path segment (bookmarkable, cohérent avec la gallery
 * qui link vers `/canvas/<id>`). Si `$connId` ne matche aucune connection
 * du user, on rend un empty-state (pas de redirect ; l'user peut relancer
 * son CLI puis F5).
 *
 * Au mount, on push l'id en tête de la liste MRU (`~/.sqlnest:recent-
 * connections` localStorage) — la gallery s'en sert pour la section
 * "Récentes".
 */
export const Route = createFileRoute("/_authenticated/canvas/$connId/")({
	component: CanvasPage
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

function CanvasPage() {
	const { connId } = Route.useParams();
	const { data: connections } = useDbConnections();
	const { data, error } = useSchema(connId);
	const connection = connections?.find((c) => c.id === connId);
	const dbName = connection?.name ?? connId;

	// MRU : push l'id au top au mount + à chaque changement de connId
	// (navigation entre canvases sans démonter le composant).
	useEffect(() => {
		pushRecentConnection(connId);
	}, [connId]);

	// Cas explicite : la liste est chargée ET l'id n'existe pas → pas
	// juste "loading" mais "unknown". Évite de laisser l'user regarder
	// un spinner en boucle sur un id supprimé.
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
	)
}
