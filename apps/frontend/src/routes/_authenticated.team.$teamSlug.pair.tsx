/**
 * Route `/team/:teamSlug/pair` — device pairing flow team-scoped.
 * Réutilise `PairPage` qui lit le slug via `useCurrentTeamSlug`.
 *
 * `validateSearch` accepte `?code=` posé par le CLI (`connect.ts`) ;
 * `PairPage` le lit via `Route.useSearch()` et l'utilise comme valeur
 * initiale du `TextInput`.
 */

import { createFileRoute } from "@tanstack/react-router";
import { PairPage } from "../features/tunnel/PairPage";

interface PairSearch {
	code: string | null;
}

function validateSearch(raw: Record<string, unknown>): PairSearch {
	if (typeof raw.code === "string" && raw.code.length > 0) {
		return { code: raw.code };
	}
	return { code: null };
}

export const Route = createFileRoute("/_authenticated/team/$teamSlug/pair")({
	component: PairPage,
	validateSearch
});
