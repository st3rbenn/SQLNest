/**
 * Route `/parity` — landing page listant les divergences PG↔Mongo
 * documentées dans le registre snql (PM/10 D20).
 */

import { createFileRoute } from "@tanstack/react-router";
import { ParityPage } from "../features/parity/ParityPage";

export const Route = createFileRoute("/_authenticated/parity")({
	component: ParityPage
});
