import { afterEach, describe, expect, it } from "vitest";
import { contentScrolls } from "./contentWheel";

function box(
	overflowY: string,
	scrollTop: number,
	scrollHeight: number,
	clientHeight: number
): HTMLElement {
	const el = document.createElement("div");
	el.style.overflowY = overflowY;
	Object.defineProperties(el, {
		scrollTop: { value: scrollTop },
		scrollHeight: { value: scrollHeight },
		clientHeight: { value: clientHeight }
	});
	return el;
}

describe("contentScrolls", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	function mount(inner: HTMLElement): {
		holder: HTMLElement;
		leaf: HTMLElement;
	} {
		const holder = document.createElement("div");
		const leaf = document.createElement("span");
		inner.append(leaf);
		holder.append(inner);
		document.body.append(holder);
		return { holder, leaf };
	}

	it("laisse la molette au canvas quand rien ne déborde", () => {
		const { holder, leaf } = mount(box("auto", 0, 100, 100));
		expect(contentScrolls(leaf, holder, 0, 40)).toBe(false);
	});

	it("garde la molette tant que la liste peut défiler dans ce sens", () => {
		const { holder, leaf } = mount(box("auto", 0, 300, 100));
		expect(contentScrolls(leaf, holder, 0, 40)).toBe(true);
		expect(contentScrolls(leaf, holder, 0, -40)).toBe(false);
	});

	it("rend la molette au canvas en bout de liste", () => {
		const { holder, leaf } = mount(box("auto", 200, 300, 100));
		expect(contentScrolls(leaf, holder, 0, 40)).toBe(false);
		expect(contentScrolls(leaf, holder, 0, -40)).toBe(true);
	});

	it("ignore un débordement qui n'est pas défilable", () => {
		const { holder, leaf } = mount(box("hidden", 0, 300, 100));
		expect(contentScrolls(leaf, holder, 0, 40)).toBe(false);
	});
});
