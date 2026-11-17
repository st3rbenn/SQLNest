import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { connectionKey } from "../../storage/localStore";
import { useOpenConsoles } from "./useOpenConsoles";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function frames(connectionId: string, ids: string[]): void {
	window.localStorage.setItem(
		connectionKey("console-nodes", connectionId),
		JSON.stringify(ids.map((id) => ({ id })))
	);
}

function saved(connectionId: string): string | null {
	return window.localStorage.getItem(
		connectionKey("console-open", connectionId)
	);
}

describe("useOpenConsoles", () => {
	beforeEach(() => window.localStorage.clear());

	it("part sans console dépliée", () => {
		const { result } = renderHook(() => useOpenConsoles(A));
		expect(result.current[0]).toEqual([]);
		expect(saved(A)).toBeNull();
	});

	it("garde les consoles dépliées d'un chargement à l'autre", () => {
		frames(A, ["console:a", "console:b"]);
		const first = renderHook(() => useOpenConsoles(A));
		act(() => first.result.current[1]((ids) => [...ids, "console:b"]));
		act(() => first.result.current[1]((ids) => [...ids, "console:a"]));
		first.unmount();
		const second = renderHook(() => useOpenConsoles(A));
		expect(second.result.current[0]).toEqual(["console:b", "console:a"]);
	});

	it("oublie une console repliée", () => {
		frames(A, ["console:a"]);
		const { result } = renderHook(() => useOpenConsoles(A));
		act(() => result.current[1](() => ["console:a"]));
		expect(saved(A)).toBe('["console:a"]');
		act(() => result.current[1](() => []));
		expect(saved(A)).toBeNull();
	});

	it("ne rouvre pas une console supprimée depuis", () => {
		frames(A, ["console:a"]);
		window.localStorage.setItem(
			connectionKey("console-open", A),
			'["console:a","console:partie"]'
		);
		const { result } = renderHook(() => useOpenConsoles(A));
		expect(result.current[0]).toEqual(["console:a"]);
	});

	it("ne mélange pas les connexions", () => {
		frames(A, ["console:a"]);
		frames(B, ["console:b"]);
		window.localStorage.setItem(
			connectionKey("console-open", B),
			'["console:b"]'
		);
		const { result, rerender } = renderHook(
			({ id }: { id: string }) => useOpenConsoles(id),
			{ initialProps: { id: A } }
		);
		act(() => result.current[1](() => ["console:a"]));
		rerender({ id: B });
		expect(result.current[0]).toEqual(["console:b"]);
		expect(saved(A)).toBe('["console:a"]');
		expect(saved(B)).toBe('["console:b"]');
	});
});
