import { DesignSystemProvider } from "@sqlnest/design-system";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	ConsoleLinksContext,
	type ConsoleLinksValue
} from "./ConsoleLinksContext";
import { menuAnchor, TableConsoleCounter } from "./TableConsoleCounter";
import type { ConsoleEntry } from "./useConsoleIndex";

// Le glisser convertit le point de l'écran en point du canvas : hors
// moteur, un décalage fixe en tient lieu.
vi.mock("@sqlnest/canvas", async (original) => ({
	...(await original<typeof import("@sqlnest/canvas")>()),
	useNestCanvas: () => ({
		screenToFlowPosition: (p: { x: number; y: number }) => ({
			x: p.x + 1000,
			y: p.y + 2000
		}),
		getZoom: () => 1
	}),
	useViewport: () => ({ x: 0, y: 0, zoom: 1 })
}));

/** Appui sur `button`, déplacement jusqu'à `to`, relâchement. */
function dragTo(button: HTMLElement, to: { x: number; y: number }) {
	fireEvent.pointerDown(button, { button: 0, clientX: 10, clientY: 10 });
	fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y });
	fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y });
}

const entry = (id: string): ConsoleEntry => ({
	id,
	tabId: "t",
	source: "find track pick name",
	title: "Pistes",
	root: "track",
	joined: []
});

function links(
	entries: ConsoleEntry[],
	open: string[],
	createFor = vi.fn(),
	openConsole = vi.fn()
): ConsoleLinksValue {
	return {
		byTable: new Map([["track", entries]]),
		attached: new Set(entries.map((e) => e.id)),
		rootOf: new Map(entries.map((e) => [e.id, e.root])),
		openIds: new Set(open),
		open: openConsole,
		fold: vi.fn(),
		createFor
	};
}

function tree(value: ConsoleLinksValue | null, table = "track") {
	return (
		<DesignSystemProvider>
			<ConsoleLinksContext.Provider value={value}>
				<TableConsoleCounter table={table} />
			</ConsoleLinksContext.Provider>
		</DesignSystemProvider>
	);
}

describe("TableConsoleCounter", () => {
	it("n'affiche rien quand le prototype est éteint", () => {
		render(tree(null));
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("propose une première console sur une table qui n'en a pas", () => {
		const createFor = vi.fn();
		render(tree(links([], [], createFor), "album"));
		fireEvent.click(screen.getByRole("button", { name: "Nouvelle console" }));
		expect(createFor).toHaveBeenCalledWith("album");
	});

	it("pose une nouvelle console là où le bouton est lâché", () => {
		const createFor = vi.fn();
		render(tree(links([], [], createFor), "album"));
		const button = screen.getByRole("button", { name: "Nouvelle console" });
		dragTo(button, { x: 200, y: 150 });
		expect(createFor).toHaveBeenCalledWith("album", { x: 1200, y: 2150 });
		// Le clic qui suit le glisser n'en ouvre pas une seconde.
		fireEvent.click(button);
		expect(createFor).toHaveBeenCalledOnce();
	});

	it("tend un lien pointillé de la table au pointeur pendant le glisser", () => {
		render(tree(links([], []), "album"));
		const button = screen.getByRole("button", { name: "Nouvelle console" });
		const line = () => document.body.querySelector("path[stroke-dasharray]");
		fireEvent.pointerDown(button, { button: 0, clientX: 10, clientY: 10 });
		expect(line()).toBeNull();
		fireEvent.pointerMove(window, { clientX: 200, clientY: 150 });
		expect(line()?.getAttribute("d")).toContain("200,150");
		fireEvent.pointerUp(window, { clientX: 200, clientY: 150 });
		expect(line()).toBeNull();
	});

	it("ne prend pas un appui sans déplacement pour un glisser", () => {
		const createFor = vi.fn();
		render(tree(links([], [], createFor), "album"));
		const button = screen.getByRole("button", { name: "Nouvelle console" });
		dragTo(button, { x: 12, y: 11 });
		expect(createFor).not.toHaveBeenCalled();
	});

	it("pose la première console repliée là où le compteur est lâché", () => {
		const createFor = vi.fn();
		const open = vi.fn();
		render(tree(links([entry("a"), entry("b")], ["a"], createFor, open)));
		dragTo(screen.getByRole("button", { name: "2 consoles" }), {
			x: 300,
			y: 40
		});
		expect(open).toHaveBeenCalledWith("b", { x: 1300, y: 2040 });
		expect(createFor).not.toHaveBeenCalled();
	});

	it("crée une console au dépôt quand toutes sont déjà dépliées", () => {
		const createFor = vi.fn();
		render(tree(links([entry("a")], ["a"], createFor)));
		dragTo(screen.getByRole("button", { name: "1 console" }), {
			x: 300,
			y: 40
		});
		expect(createFor).toHaveBeenCalledWith("track", { x: 1300, y: 2040 });
	});

	it("compte les consoles de la table", () => {
		render(tree(links([entry("a"), entry("b")], [])));
		expect(screen.getByRole("button", { name: "2 consoles" }).textContent).toBe(
			"2"
		);
	});

	it("se réduit au nombre seul sur une table devenue un bloc", () => {
		render(
			<DesignSystemProvider>
				<ConsoleLinksContext.Provider value={links([entry("a")], [])}>
					<TableConsoleCounter table="track" dense />
				</ConsoleLinksContext.Provider>
			</DesignSystemProvider>
		);
		const counter = screen.getByRole("button", { name: "1 console" });
		expect(counter.textContent).toBe("1");
		expect(counter.querySelector("svg")).toBeNull();
	});

	it("signale la console qui vient de se replier", () => {
		const both = [entry("a"), entry("b")];
		const { rerender } = render(tree(links(both, ["a"])));
		const counter = () => screen.getByRole("button", { name: "2 consoles" });
		expect(counter().className).not.toContain("sqlnest-console-flash");
		rerender(tree(links(both, [])));
		expect(counter().className).toContain("sqlnest-console-flash");
		fireEvent.animationEnd(counter());
		expect(counter().className).not.toContain("sqlnest-console-flash");
	});

	it("ne signale rien quand une console se déplie", () => {
		const both = [entry("a"), entry("b")];
		const { rerender } = render(tree(links(both, [])));
		rerender(tree(links(both, ["a"])));
		expect(
			screen.getByRole("button", { name: "2 consoles" }).className
		).not.toContain("sqlnest-console-flash");
	});

	it("ouvre la liste des consoles au clic sur le compteur", async () => {
		render(tree(links([entry("a")], [])));
		fireEvent.click(screen.getByRole("button", { name: "1 console" }));
		expect(await screen.findByText("Nouvelle console")).toBeTruthy();
		expect(screen.getByText("Pistes")).toBeTruthy();
	});
});

describe("menuAnchor", () => {
	// Table de 100 à 300 px, son compteur de 250 à 280 px, 6 px sous son haut.
	const table = { left: 100, right: 300, top: 50 };
	const button = { left: 250, right: 280, top: 56 };

	it("pose la liste contre le bord droit de la table, haut aligné", () => {
		expect(menuAnchor(button, table, 1, 1200)).toEqual({
			position: "right-start",
			offset: { mainAxis: 28, crossAxis: -6 },
			scale: 1
		});
	});

	it("passe à gauche quand la droite sort de l'écran", () => {
		const far = { left: 900, right: 1100, top: 50 };
		const farButton = { left: 1050, right: 1080, top: 56 };
		expect(menuAnchor(farButton, far, 1, 1200)).toEqual({
			position: "left-start",
			offset: { mainAxis: 158, crossAxis: -6 },
			scale: 1
		});
	});

	it("reste à droite quand aucun côté n'a la place", () => {
		const wide = { left: 50, right: 1150, top: 50 };
		expect(menuAnchor(button, wide, 1, 1200).position).toBe("right-start");
	});

	it("rétrécit avec le zoom, jusqu'à un plancher", () => {
		expect(menuAnchor(button, table, 0.9, 1200).scale).toBe(0.9);
		expect(menuAnchor(button, table, 0.55, 1200).scale).toBe(0.75);
		expect(menuAnchor(button, table, 2, 1200).scale).toBe(1);
	});
});
