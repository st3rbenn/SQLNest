/**
 * Route `/team/:teamSlug/pair` — device pairing flow team-scoped.
 * Réutilise `PairPage` qui lit le slug via `useCurrentTeamSlug`.
 */

import { createFileRoute } from "@tanstack/react-router";
import { PairPage } from "../features/tunnel/PairPage";

export const Route = createFileRoute("/_authenticated/team/$teamSlug/pair")({
	component: PairPage
});
