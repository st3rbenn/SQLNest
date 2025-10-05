import App from "../App";
import { createRootRoute } from "@tanstack/react-router";

//add layout later
export const Route = createRootRoute({
	component: () => <App />,
});
