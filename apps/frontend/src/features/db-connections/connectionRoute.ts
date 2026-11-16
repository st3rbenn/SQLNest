import { redirect } from "@tanstack/react-router";
import { notifyError } from "../notifications/notify";
import { isConnectionId } from "../storage/localStore";

export const UNKNOWN_CONNECTION_MESSAGE =
	"Cette connection n'existe pas ou n'est plus disponible.";

/**
 * Garde des routes `/team/:teamSlug/canvas/:connId/*` : un identifiant qui
 * n'en est pas un (URL tronquée) ne monte ni canvas ni console, qui
 * écriraient un état local à son nom. Retour à la galerie de l'équipe.
 */
export function requireConnectionId(params: {
	readonly teamSlug: string;
	readonly connId: string;
}): void {
	if (isConnectionId(params.connId)) return;
	notifyError(UNKNOWN_CONNECTION_MESSAGE);
	throw redirect({
		to: "/team/$teamSlug",
		params: { teamSlug: params.teamSlug }
	});
}
