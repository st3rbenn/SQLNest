import { DesignSystemProvider } from "@sqlnest/design-system";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	render as rawRender,
	screen,
	waitFor
} from "@testing-library/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock authClient AVANT l'import de VerifyEmailPage — le composant l'utilise
// pour verifyEmail. On veut contrôler la promesse résolue/rejetée pour
// tester la state machine sans dépendance réseau.
const verifyEmailMock = vi.fn();
vi.mock("./authClient", () => ({
	authClient: {
		verifyEmail: (...args: unknown[]) => verifyEmailMock(...args)
	},
	// Autres exports utilisés par les autres composants du module —
	// stubs no-op suffisent car on ne rend que VerifyEmailPage.
	signIn: {},
	signUp: {},
	signOut: () => Promise.resolve({}),
	requestPasswordReset: () => Promise.resolve({}),
	resetPassword: () => Promise.resolve({}),
	getSession: () => Promise.resolve({ data: null })
}));

// Mock TanStack Router `<Link>` — un `<a>` suffit pour vérifier que le CTA
// est rendu (on n'exécute PAS la navigation dans ces tests). Sans mock,
// `<Link>` requiert un RouterProvider avec un URL parsable (impossible sous
// happy-dom sans stack URL complète). On garde les autres exports intacts
// via `importOriginal` pour ne pas casser `createFileRoute`, `useSearch`, etc.
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		Link: ({
			to,
			children,
			...props
		}: ComponentPropsWithoutRef<"a"> & { to: string }) => (
			<a href={to} {...props}>
				{children}
			</a>
		)
	};
});

// Import APRÈS les mocks.
import { TokenMissing, VerifyEmailInner } from "./VerifyEmailPage";

/** QueryClient jetable (fresh cache par test) + Mantine + QueryClient.
 * Utilise l'option `wrapper` de RTL pour que `rerender()` preserve les
 * providers (sinon on re-monte l'arbre nu → "No QueryClient set"). */
function renderWithProviders(children: ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } }
	});
	const Wrapper = ({ children: c }: { children: ReactNode }) => (
		<DesignSystemProvider>
			<QueryClientProvider client={queryClient}>{c}</QueryClientProvider>
		</DesignSystemProvider>
	);
	return rawRender(children, { wrapper: Wrapper });
}

describe("TokenMissing", () => {
	it("rend le titre 'Lien invalide' + les 2 CTA", () => {
		renderWithProviders(<TokenMissing />);
		expect(screen.getByText("Lien invalide")).toBeDefined();
		expect(screen.getByText("Recevoir un nouveau lien")).toBeDefined();
		expect(screen.getByText("Retour à la connexion")).toBeDefined();
	});
});

describe("VerifyEmailInner — state machine", () => {
	beforeEach(() => {
		verifyEmailMock.mockReset();
	});

	it("état loading : spinner + message 'Vérification en cours…'", () => {
		// Promise qui ne résout jamais → reste en loading.
		verifyEmailMock.mockReturnValue(new Promise(() => {}));
		renderWithProviders(<VerifyEmailInner token="tok-loading" />);
		expect(screen.getByText(/Vérification en cours/)).toBeDefined();
	});

	it("état success : Alert vert + CTA 'Ouvrir le canvas'", async () => {
		verifyEmailMock.mockResolvedValue({
			data: { user: { id: "u1" } },
			error: null
		});
		renderWithProviders(<VerifyEmailInner token="tok-ok" />);
		await waitFor(() => {
			expect(screen.getByText(/Email vérifié/)).toBeDefined();
		});
		expect(screen.getByText("Ouvrir le canvas")).toBeDefined();
	});

	it("état error (result.error) : message 'invalide ou expiré'", async () => {
		verifyEmailMock.mockResolvedValue({
			data: null,
			error: { message: "Token expiré." }
		});
		renderWithProviders(<VerifyEmailInner token="tok-expired" />);
		await waitFor(() => {
			expect(screen.getByText(/invalide ou a expiré/)).toBeDefined();
		});
	});

	it("état error (throw réseau) : même message d'erreur affiché", async () => {
		verifyEmailMock.mockRejectedValue(new Error("Network down"));
		renderWithProviders(<VerifyEmailInner token="tok-network" />);
		await waitFor(() => {
			expect(screen.getByText(/invalide ou a expiré/)).toBeDefined();
		});
	});

	it("n'appelle PAS verifyEmail deux fois pour le même token (dédupe RQ)", async () => {
		verifyEmailMock.mockResolvedValue({ data: {}, error: null });
		const { rerender } = renderWithProviders(
			<VerifyEmailInner token="tok-dedupe" />
		);
		await waitFor(() => {
			expect(screen.getByText(/Email vérifié/)).toBeDefined();
		});
		// Re-render du même composant avec le même token : la query est
		// déjà en cache (staleTime Infinity + refetchOnMount false) → pas
		// de re-fetch.
		await act(async () => {
			rerender(<VerifyEmailInner token="tok-dedupe" />);
		});
		expect(verifyEmailMock).toHaveBeenCalledTimes(1);
	});
});
