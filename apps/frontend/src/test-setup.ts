// Stub `window.CONTEXT` que Vite injecte au boot via un <script> avant les
// modules. Certains hooks (useRunQuery, useSchema) lisent `window.CONTEXT.apiBaseUrl`
// à l'import (module scope) — sans ce stub, tout test qui transitivement
// remonte à ces hooks crashe avec "Cannot read properties of undefined".
if (typeof window !== "undefined") {
	const w = window as unknown as {
		CONTEXT?: { apiBaseUrl?: string };
	};
	if (w.CONTEXT === undefined) w.CONTEXT = { apiBaseUrl: "" };
}
