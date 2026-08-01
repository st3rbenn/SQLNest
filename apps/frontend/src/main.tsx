import { DesignSystemProvider } from "@sqlnest/design-system";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "./api/queryClient";
import { routeTree } from "./routeTree.gen";

const router = createRouter({
	routeTree,
	context: { queryClient }
});
declare module "@tanstack/react-router" {
	// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- type augmentation
	interface Register {
		router: typeof router;
	}
}

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Élément racine #root introuvable");
}

createRoot(rootElement).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<DesignSystemProvider>
				<RouterProvider router={router} />
			</DesignSystemProvider>
		</QueryClientProvider>
	</StrictMode>
);
