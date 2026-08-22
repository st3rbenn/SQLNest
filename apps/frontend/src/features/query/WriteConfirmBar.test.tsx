import { DesignSystemProvider } from "@sqlnest/design-system";
import {
	fireEvent,
	render as rawRender,
	screen
} from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { UnfilteredFinding } from "./unfilteredWrites";
import { expectedFor, WriteConfirmBar } from "./WriteConfirmBar";

/**
 * Tests du composant WriteConfirmBar — surface de confirmation typing du
 * verbe. Couvre : expected string par kind, activation Exécuter, Escape /
 * Annuler, Enter, compteur multi-findings. Le timeout 5s est géré côté
 * ConsoleShellInner (state React parent) — pas testé ici.
 */

function render(node: ReactNode) {
	return rawRender(<DesignSystemProvider>{node}</DesignSystemProvider>);
}

function fakeFinding(overrides: Partial<UnfilteredFinding> = {}): UnfilteredFinding {
	return {
		span: {
			start: { offset: 0, line: 1, column: 1 },
			end: { offset: 16, line: 1, column: 17 }
		},
		kind: "unfiltered_delete",
		verb: "remove",
		target: "users",
		...overrides
	};
}

describe("expectedFor — chaîne canonique à retaper", () => {
	it("unfiltered_delete → 'REMOVE FROM <target>'", () => {
		expect(expectedFor(fakeFinding())).toBe("REMOVE FROM users");
	});

	it("unfiltered_update → 'UPDATE <target>'", () => {
		expect(
			expectedFor(fakeFinding({ kind: "unfiltered_update", target: "orders" }))
		).toBe("UPDATE orders");
	});

	it("bulk_copy_insert → 'ADD INTO <target>'", () => {
		expect(
			expectedFor(fakeFinding({ kind: "bulk_copy_insert", target: "archive" }))
		).toBe("ADD INTO archive");
	});

	it("raw_opaque → 'RAW' (sans target — payload opaque)", () => {
		expect(
			expectedFor(fakeFinding({ kind: "raw_opaque", verb: "raw", target: "RAW" }))
		).toBe("RAW");
	});
});

describe("WriteConfirmBar — activation Exécuter", () => {
	it("Exécuter disabled à l'ouverture (input vide)", () => {
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		const submit = screen.getByTestId("write-confirm-submit");
		expect(submit).toHaveProperty("disabled", true);
	});

	it("Exécuter disabled tant que valeur ≠ expected", () => {
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		const input = screen.getByTestId("write-confirm-input") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "REMOVE FROM othertable" } });
		expect(screen.getByTestId("write-confirm-submit")).toHaveProperty(
			"disabled",
			true
		);
	});

	it("Exécuter activé quand valeur === expected (case-insensitive)", () => {
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		const input = screen.getByTestId("write-confirm-input") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "remove from users" } });
		expect(screen.getByTestId("write-confirm-submit")).toHaveProperty(
			"disabled",
			false
		);
	});

	it("Exécuter activé même avec espaces multiples (normalisation)", () => {
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		const input = screen.getByTestId("write-confirm-input") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "  REMOVE   FROM   users  " } });
		expect(screen.getByTestId("write-confirm-submit")).toHaveProperty(
			"disabled",
			false
		);
	});
});

describe("WriteConfirmBar — actions user", () => {
	it("clic Exécuter avec valeur valide → onConfirm", () => {
		const onConfirm = vi.fn();
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				onConfirm={onConfirm}
				onCancel={vi.fn()}
			/>
		);
		const input = screen.getByTestId("write-confirm-input") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "REMOVE FROM users" } });
		fireEvent.click(screen.getByTestId("write-confirm-submit"));
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it("Enter avec valeur valide → onConfirm", () => {
		const onConfirm = vi.fn();
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				onConfirm={onConfirm}
				onCancel={vi.fn()}
			/>
		);
		const input = screen.getByTestId("write-confirm-input") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "REMOVE FROM users" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it("Enter avec valeur invalide → NE PAS appeler onConfirm", () => {
		const onConfirm = vi.fn();
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				onConfirm={onConfirm}
				onCancel={vi.fn()}
			/>
		);
		const input = screen.getByTestId("write-confirm-input") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "remove" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("clic Annuler → onCancel", () => {
		const onCancel = vi.fn();
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				onConfirm={vi.fn()}
				onCancel={onCancel}
			/>
		);
		fireEvent.click(screen.getByTestId("write-confirm-cancel"));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("Escape → onCancel (même sans avoir tapé)", () => {
		const onCancel = vi.fn();
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				onConfirm={vi.fn()}
				onCancel={onCancel}
			/>
		);
		const input = screen.getByTestId("write-confirm-input") as HTMLInputElement;
		fireEvent.keyDown(input, { key: "Escape" });
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});

describe("WriteConfirmBar — multi-findings", () => {
	it("N > 1 : affiche compteur (1/N) + liste tous les findings", () => {
		render(
			<WriteConfirmBar
				findings={[
					fakeFinding({ target: "users" }),
					fakeFinding({ target: "orders" }),
					fakeFinding({ target: "carts" })
				]}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		expect(screen.getByText("(1/3)")).toBeDefined();
		const list = screen.getByTestId("write-confirm-findings");
		expect(list.textContent).toContain("REMOVE FROM users");
		expect(list.textContent).toContain("REMOVE FROM orders");
		expect(list.textContent).toContain("REMOVE FROM carts");
	});

	it("N === 1 : pas de compteur, pas de liste", () => {
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		expect(screen.queryByText(/\(1\/\d+\)/)).toBeNull();
		expect(screen.queryByTestId("write-confirm-findings")).toBeNull();
	});

	it("Le typing valide le PREMIER finding uniquement (bar assume l'user en a vu la liste)", () => {
		const onConfirm = vi.fn();
		render(
			<WriteConfirmBar
				findings={[
					fakeFinding({ target: "users" }),
					fakeFinding({ target: "orders" })
				]}
				onConfirm={onConfirm}
				onCancel={vi.fn()}
			/>
		);
		const input = screen.getByTestId("write-confirm-input") as HTMLInputElement;
		// Typer le premier ("users") active Exécuter, même si un second existe.
		fireEvent.change(input, { target: { value: "REMOVE FROM users" } });
		expect(screen.getByTestId("write-confirm-submit")).toHaveProperty(
			"disabled",
			false
		);
	});
});

describe("WriteConfirmBar — preview count", () => {
	it("preview=null (loading) → badge 'Estimation…'", () => {
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				preview={null}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		expect(screen.getByTestId("write-confirm-preview-loading")).toBeDefined();
	});

	it("preview.status=ok → badge '≈ N lignes' avec formatage français", () => {
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				preview={{ status: "ok", estimatedRowCount: 47293 }}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		const badge = screen.getByTestId("write-confirm-preview-count");
		expect(badge.textContent).toContain("47");
		expect(badge.textContent).toContain("293");
		expect(badge.textContent).toContain("lignes");
	});

	it("preview.status=ok avec estimatedRowCount=1 → singulier 'ligne'", () => {
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				preview={{ status: "ok", estimatedRowCount: 1 }}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		expect(screen.getByTestId("write-confirm-preview-count").textContent).toContain(
			"1 ligne"
		);
	});

	it("preview.status=ok avec estimatedRowCount=0 → 'lignes' (pluriel FR reste avec 0)", () => {
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				preview={{ status: "ok", estimatedRowCount: 0 }}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		expect(screen.getByTestId("write-confirm-preview-count").textContent).toContain(
			"lignes"
		);
	});

	it("preview.status=unavailable reason=timeout → 'Estimation indisponible (timeout)'", () => {
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				preview={{ status: "unavailable", reason: "timeout" }}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		const badge = screen.getByTestId("write-confirm-preview-unavailable");
		expect(badge.textContent).toContain("timeout");
	});

	it("preview.status=unavailable reason=unsupported → 'Estimation indisponible'", () => {
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				preview={{ status: "unavailable", reason: "unsupported" }}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		expect(
			screen.getByTestId("write-confirm-preview-unavailable").textContent
		).toBe("Estimation indisponible");
	});

	it("preview.status=ok avec disclaimer join (D17) → ligne warning distincte", () => {
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				preview={{
					status: "ok",
					estimatedRowCount: 42,
					disclaimer:
						"Count via join — peut différer si le join a des filtres implicites"
				}}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		const disc = screen.getByTestId("write-confirm-preview-disclaimer");
		expect(disc.textContent).toContain("join");
	});

	it("preview=undefined (parent n'a pas set) → aucun badge preview rendu", () => {
		render(
			<WriteConfirmBar
				findings={[fakeFinding()]}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		expect(screen.queryByTestId("write-confirm-preview-loading")).toBeNull();
		expect(screen.queryByTestId("write-confirm-preview-count")).toBeNull();
		expect(
			screen.queryByTestId("write-confirm-preview-unavailable")
		).toBeNull();
	});
});

describe("WriteConfirmBar — findings vide (edge case)", () => {
	it("findings=[] → rend null (parent devrait skip mais défensif)", () => {
		render(
			<WriteConfirmBar
				findings={[]}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		// Rien de nos éléments propres ne doit être présent — Mantine injecte
		// ses CSS vars dans le DOM (visibles dans le container), on teste via
		// testId ciblés qui appartiennent bien à la bar.
		expect(screen.queryByTestId("write-confirm-input")).toBeNull();
		expect(screen.queryByTestId("write-confirm-submit")).toBeNull();
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});
});
