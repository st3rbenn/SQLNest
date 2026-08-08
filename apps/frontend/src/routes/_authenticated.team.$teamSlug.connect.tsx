/**
 * Route `/team/:teamSlug/connect` — device flow team-scoped (C.21.5).
 * Réutilise `ConnectPage` qui lit le slug via `useCurrentTeamSlug`.
 */

import { createFileRoute } from "@tanstack/react-router";
import { ConnectPage } from "../features/tunnel/ConnectPage";

export const Route = createFileRoute("/_authenticated/team/$teamSlug/connect")({
	component: ConnectPage
});
