import { createFileRoute } from "@tanstack/react-router";
import { ConnectPage } from "../features/tunnel/ConnectPage";

/**
 * Route `/connect` — finalise le pairing device flow d'un CLI SQLNest.
 * Auth-required (guard hérité de `_authenticated`).
 */
export const Route = createFileRoute("/_authenticated/connect")({
	component: ConnectPage
});
