import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test-utils/render";
import { useCommandPaletteShortcut } from "./useCommandPaletteShortcut";

function Harness({ onOpen }: { onOpen: () => void }) {
	useCommandPaletteShortcut(onOpen);
	return (
		<div>
			<input placeholder="type-here" />
			<textarea placeholder="area-here" />
		</div>
	);
}

describe("useCommandPaletteShortcut", () => {
	it("fires the callback on Cmd+K (mac)", () => {
		const onOpen = vi.fn();
		renderWithProviders(<Harness onOpen={onOpen} />);
		fireEvent.keyDown(document, { key: "k", metaKey: true });
		expect(onOpen).toHaveBeenCalledOnce();
	});

	it("fires the callback on Ctrl+K (windows/linux)", () => {
		const onOpen = vi.fn();
		renderWithProviders(<Harness onOpen={onOpen} />);
		fireEvent.keyDown(document, { key: "k", ctrlKey: true });
		expect(onOpen).toHaveBeenCalledOnce();
	});

	it("does not fire on plain k", () => {
		const onOpen = vi.fn();
		renderWithProviders(<Harness onOpen={onOpen} />);
		fireEvent.keyDown(document, { key: "k" });
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("still fires even when a text input has focus (palette must be reachable from anywhere)", () => {
		const onOpen = vi.fn();
		const { getByPlaceholderText } = renderWithProviders(
			<Harness onOpen={onOpen} />,
		);
		const input = getByPlaceholderText("type-here");
		input.focus();
		fireEvent.keyDown(input, { key: "k", metaKey: true, bubbles: true });
		expect(onOpen).toHaveBeenCalledOnce();
	});

	it("prevents the browser default on Cmd+K", () => {
		const onOpen = vi.fn();
		renderWithProviders(<Harness onOpen={onOpen} />);
		const evt = new KeyboardEvent("keydown", {
			key: "k",
			metaKey: true,
			cancelable: true,
			bubbles: true,
		});
		document.dispatchEvent(evt);
		expect(evt.defaultPrevented).toBe(true);
	});

	it("unsubscribes on unmount", () => {
		const onOpen = vi.fn();
		const { unmount } = renderWithProviders(<Harness onOpen={onOpen} />);
		unmount();
		fireEvent.keyDown(document, { key: "k", metaKey: true });
		expect(onOpen).not.toHaveBeenCalled();
	});
});
