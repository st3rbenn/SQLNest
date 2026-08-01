import { describe, expect, it, vi } from "vitest";
import {
	renderWithProviders,
	screen,
	userEvent,
} from "../../test-utils/render";
import { SidebarDrawer } from "./SidebarDrawer";

const TABS = [
	{ value: "tables", label: "Tables" },
	{ value: "frames", label: "Frames", count: 4 },
	{ value: "diff", label: "Diff" },
];

describe("SidebarDrawer", () => {
	it("renders one tab per entry with its label", () => {
		renderWithProviders(
			<SidebarDrawer tabs={TABS} value="tables">
				<div>content</div>
			</SidebarDrawer>,
		);
		expect(screen.getByRole("tab", { name: /tables/i })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: /frames/i })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: /diff/i })).toBeInTheDocument();
	});

	it("displays the numeric count next to a tab when provided", () => {
		renderWithProviders(
			<SidebarDrawer tabs={TABS} value="tables">
				x
			</SidebarDrawer>,
		);
		const framesTab = screen.getByRole("tab", { name: /frames/i });
		expect(framesTab).toHaveTextContent("4");
	});

	it("calls onTabChange when a tab is clicked", async () => {
		const onTabChange = vi.fn();
		renderWithProviders(
			<SidebarDrawer tabs={TABS} value="tables" onTabChange={onTabChange}>
				x
			</SidebarDrawer>,
		);
		await userEvent.click(screen.getByRole("tab", { name: /frames/i }));
		expect(onTabChange).toHaveBeenCalledWith("frames");
	});

	it("renders the header slot above the body", () => {
		renderWithProviders(
			<SidebarDrawer
				tabs={TABS}
				value="tables"
				header={<input placeholder="Rechercher…" />}
			>
				<div>body</div>
			</SidebarDrawer>,
		);
		expect(screen.getByPlaceholderText("Rechercher…")).toBeInTheDocument();
		expect(screen.getByText("body")).toBeInTheDocument();
	});

	it("renders without any tab bar when tabs are omitted", () => {
		renderWithProviders(
			<SidebarDrawer header={<span>hdr</span>}>
				<div>body</div>
			</SidebarDrawer>,
		);
		expect(screen.queryByRole("tab")).toBeNull();
		expect(screen.getByText("hdr")).toBeInTheDocument();
		expect(screen.getByText("body")).toBeInTheDocument();
	});

	it("renders a title in place of tabs when title is provided and tabs are omitted", () => {
		renderWithProviders(
			<SidebarDrawer title="Schéma">
				<div>body</div>
			</SidebarDrawer>,
		);
		expect(screen.getByText("Schéma")).toBeInTheDocument();
		expect(screen.queryByRole("tab")).toBeNull();
	});

	it("renders a footer slot below the body when provided", () => {
		renderWithProviders(
			<SidebarDrawer footer={<span>foot</span>}>
				<div>body</div>
			</SidebarDrawer>,
		);
		expect(screen.getByText("foot")).toBeInTheDocument();
		expect(screen.getByText("body")).toBeInTheDocument();
	});

	it("exposes data-variant='docked' when variant='docked'", () => {
		renderWithProviders(
			<SidebarDrawer variant="docked" data-testid="drawer">
				<div>body</div>
			</SidebarDrawer>,
		);
		expect(screen.getByTestId("drawer")).toHaveAttribute(
			"data-variant",
			"docked",
		);
	});

	it("defaults to variant='floating'", () => {
		renderWithProviders(
			<SidebarDrawer data-testid="drawer">
				<div>body</div>
			</SidebarDrawer>,
		);
		expect(screen.getByTestId("drawer")).toHaveAttribute(
			"data-variant",
			"floating",
		);
	});
});
