import { Outlet } from "@tanstack/react-router";

/**
 * Shell minimal : plus de header/navigation top (le canvas Schéma prend
 * tout le viewport, à la Figma). Le healthcheck a été DÉPLACÉ dans
 * `_authenticated` layout (F10) — il n'a pas de sens sur les pages
 * `_auth` (login/signup/…) qui affichent leur propre UI. La navigation
 * entre pages passera par le breadcrumb futur (cf. memory
 * `todo-canvas-breadcrumbs`) et la palette Cmd+K.
 */
function App() {
	return <Outlet />;
}

export default App;
