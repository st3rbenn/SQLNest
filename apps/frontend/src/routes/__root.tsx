import { createRootRoute } from "@tanstack/react-router";
import App from "../App";

//add layout later
export const Route = createRootRoute({
	component: () => <App />
});
