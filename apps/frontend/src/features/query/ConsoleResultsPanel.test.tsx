import { DesignSystemProvider } from "@sqlnest/design-system";
import { render as rawRender, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ConsoleResultsPanel } from "./ConsoleResultsPanel";
import type { QueryResult } from "./useRunQuery";
import { SnqlRuntimeError } from "./useRunQuery";

/**
 * Tests des changements [[ADR-023]] E/6 sur ConsoleResultsPanel :
 *  - D15 : distinction rowCount (0 vs > 0) dans le status label
 *  - D12 : badge rollback (user-initiated vs error-triggered) via classify
 *  - D5  : header partial-writes quand tx wrap sur engine no-tx
 *
 * On focus le status bar text via `screen.getByText` — pas de simulation
 * ResultsTable/JsonView (composants découplés).
 */

function render(node: ReactNode) {
	return rawRender(<DesignSystemProvider>{node}</DesignSystemProvider>);
}

function selectResult(rowCount: number, written: boolean): QueryResult {
	return {
		columns: [],
		rows: [],
		rowCount,
		written
	};
}

describe("ConsoleResultsPanel — D15 distinction rowCount", () => {
	it("write + rowCount > 0 → 'Écriture OK' vert + 'N lignes affectées'", () => {
		render(
			<ConsoleResultsPanel
				result={selectResult(42, true)}
				error={null}
				isPending={false}
				timingMs={12}
			/>
		);
		expect(screen.getByText("Écriture OK")).toBeDefined();
		expect(screen.getByText("42 lignes affectées")).toBeDefined();
	});

	it("write + rowCount === 0 → 'Écriture exécutée' neutre + 'aucune ligne affectée'", () => {
		render(
			<ConsoleResultsPanel
				result={selectResult(0, true)}
				error={null}
				isPending={false}
				timingMs={5}
			/>
		);
		expect(screen.getByText("Écriture exécutée")).toBeDefined();
		expect(screen.getByText("aucune ligne affectée")).toBeDefined();
		// PAS "Écriture OK" — évite faux positif audit upsert idempotent.
		expect(screen.queryByText("Écriture OK")).toBeNull();
	});

	it("select (written=false) → 'Succès' vert (comportement legacy préservé)", () => {
		render(
			<ConsoleResultsPanel
				result={selectResult(3, false)}
				error={null}
				isPending={false}
				timingMs={2}
			/>
		);
		expect(screen.getByText("Succès")).toBeDefined();
	});
});

describe("ConsoleResultsPanel — D12 rollback badge", () => {
	it("SQLSTATE 40P01 deadlock → label 'Transaction annulée' danger", () => {
		const err = new SnqlRuntimeError("deadlock detected", {
			message: "deadlock detected",
			code: "40P01"
		});
		render(
			<ConsoleResultsPanel
				result={undefined}
				error={err}
				isPending={false}
				timingMs={undefined}
			/>
		);
		expect(screen.getByTestId("status-pill").textContent).toContain(
			"Transaction annulée"
		);
	});

	it("SQLSTATE 25P01 no_active_tx → label 'Rollback' neutre (user-initiated)", () => {
		const err = new SnqlRuntimeError("no active transaction", {
			message: "no active transaction",
			code: "25P01"
		});
		render(
			<ConsoleResultsPanel
				result={undefined}
				error={err}
				isPending={false}
				timingMs={undefined}
			/>
		);
		expect(screen.getByTestId("status-pill").textContent).toContain(
			"Rollback"
		);
	});

	it("Mongo WriteConflict → label 'Transaction annulée' (rollback_error)", () => {
		const err = new SnqlRuntimeError(
			"MongoServerError: WriteConflict at users"
		);
		render(
			<ConsoleResultsPanel
				result={undefined}
				error={err}
				isPending={false}
				timingMs={undefined}
			/>
		);
		expect(screen.getByTestId("status-pill").textContent).toContain(
			"Transaction annulée"
		);
	});

	it("SQLSTATE 42P01 undefined_table → label 'Erreur' danger (rendu legacy)", () => {
		const err = new SnqlRuntimeError('relation "foo" does not exist', {
			message: "relation foo",
			code: "42P01"
		});
		render(
			<ConsoleResultsPanel
				result={undefined}
				error={err}
				isPending={false}
				timingMs={undefined}
			/>
		);
		const pill = screen.getByTestId("status-pill");
		expect(pill.textContent).toContain("Erreur");
		expect(pill.textContent).not.toContain("Transaction annulée");
	});
});

describe("ConsoleResultsPanel — D5 header partial-writes", () => {
	it("tx wrap + engine=kv (no-tx capability) + write → header visible", () => {
		render(
			<ConsoleResultsPanel
				result={selectResult(1, true)}
				error={null}
				isPending={false}
				timingMs={5}
				engine="kv"
				lastSource="transaction { remove from users }"
			/>
		);
		expect(screen.getByTestId("partial-writes-header")).toBeDefined();
	});

	it("tx wrap + engine=postgres (tx capable) → header MASQUÉ", () => {
		render(
			<ConsoleResultsPanel
				result={selectResult(1, true)}
				error={null}
				isPending={false}
				timingMs={5}
				engine="postgres"
				lastSource="transaction { remove from users }"
			/>
		);
		expect(screen.queryByTestId("partial-writes-header")).toBeNull();
	});

	it("write hors tx + engine=kv → header MASQUÉ (source ne commence pas par transaction)", () => {
		render(
			<ConsoleResultsPanel
				result={selectResult(1, true)}
				error={null}
				isPending={false}
				timingMs={5}
				engine="kv"
				lastSource="remove from users"
			/>
		);
		expect(screen.queryByTestId("partial-writes-header")).toBeNull();
	});

	it("engine/lastSource absents → header MASQUÉ (safe fallback)", () => {
		render(
			<ConsoleResultsPanel
				result={selectResult(1, true)}
				error={null}
				isPending={false}
				timingMs={5}
			/>
		);
		expect(screen.queryByTestId("partial-writes-header")).toBeNull();
	});
});
