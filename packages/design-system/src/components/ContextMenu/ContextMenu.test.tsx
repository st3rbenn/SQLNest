import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "../../test-utils/render";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

const items: ContextMenuItem[] = [
	{ kind: "action", id: "open", label: "Ouvrir", hint: "get orders" },
	{ kind: "action", id: "data", label: "Voir les données" },
	{ kind: "divider" },
	{ kind: "action", id: "copy", label: "Copier le nom" },
];

describe("ContextMenu", () => {
	it("does not render when open is false", () => {
		renderWithProviders(
			<ContextMenu
				open={false}
				position={{ x: 0, y: 0 }}
				onClose={() => {}}
				items={items}
			/>,
		);
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("renders every action item as a menuitem when open", () => {
		renderWithProviders(
			<ContextMenu
				open
				position={{ x: 100, y: 200 }}
				onClose={() => {}}
				items={items}
			/>,
		);
		expect(
			screen.getByRole("menuitem", { name: /ouvrir/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: /voir les données/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: /copier le nom/i }),
		).toBeInTheDocument();
	});

	it("shows the title when provided", () => {
		renderWithProviders(
			<ContextMenu
				open
				position={{ x: 0, y: 0 }}
				onClose={() => {}}
				items={items}
				title="orders"
			/>,
		);
		expect(screen.getByText("orders")).toBeInTheDocument();
	});

	it("shows the hint next to an action when provided", () => {
		renderWithProviders(
			<ContextMenu
				open
				position={{ x: 0, y: 0 }}
				onClose={() => {}}
				items={items}
			/>,
		);
		expect(screen.getByText("get orders")).toBeInTheDocument();
	});

	it("fires the item's onClick and closes when an action is picked", async () => {
		const onOpen = vi.fn();
		const onClose = vi.fn();
		renderWithProviders(
			<ContextMenu
				open
				position={{ x: 0, y: 0 }}
				onClose={onClose}
				items={[
					{ kind: "action", id: "open", label: "Ouvrir", onClick: onOpen },
				]}
			/>,
		);
		await userEvent.click(screen.getByRole("menuitem", { name: /ouvrir/i }));
		expect(onOpen).toHaveBeenCalledOnce();
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("closes on Escape", async () => {
		const onClose = vi.fn();
		renderWithProviders(
			<ContextMenu
				open
				position={{ x: 0, y: 0 }}
				onClose={onClose}
				items={items}
			/>,
		);
		await userEvent.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("closes when clicking outside the menu", async () => {
		const onClose = vi.fn();
		renderWithProviders(
			<div>
				<span data-testid="outside">outside</span>
				<ContextMenu
					open
					position={{ x: 0, y: 0 }}
					onClose={onClose}
					items={items}
				/>
			</div>,
		);
		await userEvent.click(screen.getByTestId("outside"));
		expect(onClose).toHaveBeenCalled();
	});

	it("positions itself at the given coordinates", () => {
		renderWithProviders(
			<ContextMenu
				open
				position={{ x: 240, y: 180 }}
				onClose={() => {}}
				items={items}
			/>,
		);
		const menu = screen.getByRole("menu");
		expect(menu).toHaveStyle({ position: "fixed" });
		expect(menu.style.left).toBe("240px");
		expect(menu.style.top).toBe("180px");
	});

	it("renders a submenu label with a chevron indicator", () => {
		renderWithProviders(
			<ContextMenu
				open
				position={{ x: 0, y: 0 }}
				onClose={() => {}}
				items={[
					{
						kind: "submenu",
						id: "frame",
						label: "Ajouter à un frame",
						items: [
							{
								kind: "action",
								id: "u",
								label: "Utilisateurs",
							},
						],
					},
				]}
			/>,
		);
		const trigger = screen.getByRole("menuitem", {
			name: /ajouter à un frame/i,
		});
		expect(trigger).toHaveTextContent("›");
	});
});
