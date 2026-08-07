/**
 * Tests unit — ConnectPage.
 * Mock global fetch pour éviter le réseau réel.
 */

import { DesignSystemProvider } from "@sqlnest/design-system";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConnectPage } from "./ConnectPage";

function wrap(node: ReactNode) {
	return <DesignSystemProvider>{node}</DesignSystemProvider>;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = vi.fn();
	// Le composant lit `window.CONTEXT.apiBaseUrl` au module-load — mock-le.
	// biome-ignore lint/suspicious/noExplicitAny: window global test
	(globalThis as any).window = (globalThis as any).window ?? {};
	// biome-ignore lint/suspicious/noExplicitAny: window global test
	(globalThis.window as any).CONTEXT = { apiBaseUrl: "http://test-api" };
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("ConnectPage", () => {
	test("rend le formulaire avec les 2 inputs et le bouton", () => {
		render(wrap(<ConnectPage />));
		expect(screen.getByTestId("code-input")).toBeTruthy();
		expect(screen.getByTestId("name-input")).toBeTruthy();
		expect(screen.getByTestId("submit")).toBeTruthy();
	});

	async function submitForm(code: string, name: string): Promise<void> {
		const codeInput = screen.getByTestId("code-input");
		const nameInput = screen.getByTestId("name-input");
		fireEvent.change(codeInput, { target: { value: code } });
		fireEvent.change(nameInput, { target: { value: name } });
		fireEvent.submit(codeInput.closest("form") as HTMLFormElement);
	}

	test("happy path — 200 → écran de succès + POST /approve avec code normalisé", async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), { status: 200 })
		);
		render(wrap(<ConnectPage />));
		await submitForm("ABCD-1234", "apollon");

		await waitFor(() => {
			expect(screen.getByText(/Autorisé/i)).toBeTruthy();
		});
		expect(screen.getByText(/retourne dans ton terminal/i)).toBeTruthy();

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// biome-ignore lint/suspicious/noExplicitAny: mock inspection
		const [url, opts] = (fetchMock.mock.calls[0] ?? []) as [string, any];
		expect(url).toBe(
			"http://test-api/api/tunnels/pairings/ABCD1234/approve"
		);
		expect(opts.method).toBe("POST");
		expect(opts.credentials).toBe("include");
		expect(JSON.parse(opts.body)).toEqual({ deviceName: "apollon" });
	});

	test("normalise le code (lowercase + Crockford I/O/L/U → 1/0/1/V)", async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), { status: 200 })
		);
		render(wrap(<ConnectPage />));
		await submitForm("ilou-1234", "prod");
		await waitFor(() => {
			expect(
				(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length
			).toBe(1);
		});
		const [url] = ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] ??
			[]) as string[];
		expect(url).toBe(
			"http://test-api/api/tunnels/pairings/110V1234/approve"
		);
	});

	test("HTTP 410 (code expiré) → alerte avec message backend", async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(JSON.stringify({ message: "Code expiré" }), { status: 410 })
		);
		render(wrap(<ConnectPage />));
		await submitForm("ABCD-1234", "apollon");
		await waitFor(() => {
			expect(screen.getByText(/Code expiré/i)).toBeTruthy();
		});
		expect(screen.queryByText(/Autorisé/i)).toBeNull();
	});

	test("HTTP 409 (nom en conflit) → alerte avec message backend", async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(
				JSON.stringify({ message: "Une connexion avec ce nom existe déjà" }),
				{ status: 409 }
			)
		);
		render(wrap(<ConnectPage />));
		await submitForm("ABCD-1234", "prod");
		await waitFor(() => {
			expect(
				screen.getByText(/connexion avec ce nom existe/i)
			).toBeTruthy();
		});
	});

	test("erreur réseau → alerte générique", async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("network down")
		);
		render(wrap(<ConnectPage />));
		await submitForm("ABCD-1234", "apollon");
		await waitFor(() => {
			expect(screen.getByText(/network down/i)).toBeTruthy();
		});
	});
});
