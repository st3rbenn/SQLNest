import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Stub `window.CONTEXT` que Vite injecte au boot via un <script> avant les
// modules. Certains hooks (useRunQuery, useSchema) lisent `window.CONTEXT.apiBaseUrl`
// à l'import (module scope) — sans ce stub, tout test qui transitivement
// remonte à ces hooks crashe avec "Cannot read properties of undefined".
if (typeof window !== "undefined") {
	const w = window as unknown as {
		CONTEXT?: { apiBaseUrl?: string };
	};
	// URL absolue OBLIGATOIRE : Better Auth valide baseURL au parse et
	// throw sur une URL relative (ex: `/api/auth` → "Invalid base URL").
	// L'authClient est importé transitivement par plusieurs composants
	// (VerifyEmailPage, OAuthButtons…) → un test qui monte un de ceux-ci
	// crashe au module-load sans URL absolue.
	if (w.CONTEXT === undefined)
		w.CONTEXT = { apiBaseUrl: "http://localhost:4000" };
}

// Vitest n'injecte pas les globals par défaut (`globals: false` implicite) —
// l'auto-cleanup que @testing-library/react enregistrerait normalement via
// `afterEach(cleanup)` ne fire donc jamais. Sans ça, les composants montés
// via `render` / `renderHook` restent live entre les tests : leurs setTimeouts,
// listeners globaux (beforeunload, pagehide, visibilitychange) et effets async
// débordent d'un test sur les suivants. On enregistre l'unmount manuellement.
afterEach(() => {
	cleanup();
});
