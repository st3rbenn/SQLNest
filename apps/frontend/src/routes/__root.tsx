import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext } from "@tanstack/react-router";
import App from "../App";

/**
 * Contexte du router — accessible dans tous les `beforeLoad`/`loader`.
 * On y injecte `queryClient` pour que les layouts pathless (`_authenticated`)
 * puissent `ensureQueryData(sessionQueryOptions())` avant de résoudre la route,
 * sans hook React ni double-fetch côté composant.
 */
export interface RouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	component: App
});
