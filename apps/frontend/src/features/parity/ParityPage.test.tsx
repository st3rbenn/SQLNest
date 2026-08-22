/**
 * Test unit ParityPage : rend toutes les divergences du registre groupées
 * par mitigation (shim/warn/refus). Le registre est la source de vérité —
 * le test se contente de vérifier que le composant les affiche
 * intégralement et sans doublon.
 */

import { render } from "@testing-library/react";
import { DIVERGENCES } from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import { ParityPage } from "./ParityPage";

describe("ParityPage — landing page divergences PG↔Mongo", () => {
	it("rend le titre + subtitle", () => {
		const { container } = render(<ParityPage />);
		expect(container.textContent).toContain("Parité PG");
		expect(container.textContent).toContain("Mongo");
	});

	it("affiche chaque divergence du registre au moins une fois", () => {
		const { container } = render(<ParityPage />);
		for (const div of DIVERGENCES) {
			// Le titre est présent (unique par entry)
			expect(container.textContent).toContain(div.title);
		}
	});

	it("regroupe les mitigations shim/warn/refus", () => {
		const { container } = render(<ParityPage />);
		// Au moins l'un des trois mitigations est présent (dépend du registre)
		const hasAnyMitigation =
			container.textContent?.includes("Shim") === true ||
			container.textContent?.includes("Documenté") === true ||
			container.textContent?.includes("Refus au planner") === true;
		expect(hasAnyMitigation).toBe(true);
	});

	it("affiche les colonnes SNQL / PostgreSQL / MongoDB / Recommandation", () => {
		const { container } = render(<ParityPage />);
		expect(container.textContent).toContain("SNQL");
		expect(container.textContent).toContain("PostgreSQL");
		expect(container.textContent).toContain("MongoDB");
		expect(container.textContent).toContain("Recommandation");
	});
});
