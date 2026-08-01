import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHistoryStack } from "./useHistoryStack";

interface State {
	readonly count: number;
	readonly label?: string;
}

/**
 * Petit harness : le state "présent" est stocké dans un objet mutable
 * externe au hook — snapshot() en lit une copie, restore() écrit.
 */
function setup(
	initial: State = { count: 0 },
	extra: {
		readonly max?: number;
		readonly equals?: (a: State, b: State) => boolean;
	} = {}
) {
	const ref: { current: State } = { current: initial };
	const snapshot = vi.fn<() => State>(() => ({ ...ref.current }));
	const restore = vi.fn<(s: State) => void>((s) => {
		ref.current = { ...s };
	});
	const hook = renderHook(() =>
		useHistoryStack<State>({ snapshot, restore, ...extra })
	);
	const setCount = (n: number) => {
		ref.current = { ...ref.current, count: n };
	};
	return { hook, snapshot, restore, ref, setCount };
}

describe("useHistoryStack", () => {
	it("démarre avec canUndo=false et canRedo=false", () => {
		const { hook } = setup();
		expect(hook.result.current.canUndo).toBe(false);
		expect(hook.result.current.canRedo).toBe(false);
	});

	it("push ajoute au past et met canUndo=true", () => {
		const { hook, setCount } = setup({ count: 0 });
		act(() => {
			hook.result.current.push();
		});
		expect(hook.result.current.canUndo).toBe(true);
		expect(hook.result.current.canRedo).toBe(false);

		setCount(1);
		act(() => {
			hook.result.current.push();
		});
		expect(hook.result.current.canUndo).toBe(true);
	});

	it("push dédupe si le snapshot est égal au top du past (JSON.stringify)", () => {
		const { hook, snapshot } = setup({ count: 0 });
		act(() => {
			hook.result.current.push();
		});
		// snapshot appelé une fois pour ce push
		const callsAfterFirst = snapshot.mock.calls.length;
		act(() => {
			hook.result.current.push();
		});
		// snapshot est bien re-appelé pour dédupe, mais past reste inchangé
		expect(snapshot.mock.calls.length).toBe(callsAfterFirst + 1);
		// Preuve indirecte : un undo ne rappelle qu'une seule fois
		act(() => {
			hook.result.current.undo();
		});
		expect(hook.result.current.canUndo).toBe(false);
	});

	it("undo restore le dernier past, incrémente future et rappelle canUndo/Redo", () => {
		const { hook, restore, setCount, ref } = setup({ count: 0 });
		act(() => {
			hook.result.current.push();
		});
		setCount(42);
		act(() => {
			hook.result.current.undo();
		});
		expect(restore).toHaveBeenCalledTimes(1);
		expect(restore).toHaveBeenCalledWith({ count: 0 });
		expect(ref.current).toEqual({ count: 0 });
		expect(hook.result.current.canUndo).toBe(false);
		expect(hook.result.current.canRedo).toBe(true);
	});

	it("redo restore le futur, incrémente past et est symétrique de undo", () => {
		const { hook, restore, setCount, ref } = setup({ count: 0 });
		act(() => {
			hook.result.current.push();
		});
		setCount(7);
		act(() => {
			hook.result.current.undo();
		});
		// après undo, ref.current === {count:0}, futur contient {count:7}
		act(() => {
			hook.result.current.redo();
		});
		expect(restore).toHaveBeenLastCalledWith({ count: 7 });
		expect(ref.current).toEqual({ count: 7 });
		expect(hook.result.current.canUndo).toBe(true);
		expect(hook.result.current.canRedo).toBe(false);
	});

	it("push après undo clear le future", () => {
		const { hook, setCount } = setup({ count: 0 });
		act(() => {
			hook.result.current.push();
		});
		setCount(1);
		act(() => {
			hook.result.current.push();
		});
		act(() => {
			hook.result.current.undo();
		});
		expect(hook.result.current.canRedo).toBe(true);
		setCount(2);
		act(() => {
			hook.result.current.push();
		});
		expect(hook.result.current.canRedo).toBe(false);
	});

	it("undo no-op si past est vide", () => {
		const { hook, restore } = setup();
		act(() => {
			hook.result.current.undo();
		});
		expect(restore).not.toHaveBeenCalled();
		expect(hook.result.current.canUndo).toBe(false);
	});

	it("redo no-op si future est vide", () => {
		const { hook, restore } = setup();
		act(() => {
			hook.result.current.redo();
		});
		expect(restore).not.toHaveBeenCalled();
		expect(hook.result.current.canRedo).toBe(false);
	});

	it("max cap trim les plus vieux (par la tête)", () => {
		const { hook, setCount, restore } = setup({ count: 0 }, { max: 3 });
		// Pousse 5 snapshots distincts : 0, 1, 2, 3, 4
		for (let i = 0; i < 5; i++) {
			setCount(i);
			act(() => {
				hook.result.current.push();
			});
		}
		// past doit contenir seulement les 3 derniers : [2, 3, 4]
		// on unwind avec 3 undos
		setCount(999); // état courant qui va être poussé dans future à chaque undo
		act(() => {
			hook.result.current.undo();
		});
		expect(restore).toHaveBeenLastCalledWith({ count: 4 });
		act(() => {
			hook.result.current.undo();
		});
		expect(restore).toHaveBeenLastCalledWith({ count: 3 });
		act(() => {
			hook.result.current.undo();
		});
		expect(restore).toHaveBeenLastCalledWith({ count: 2 });
		// past épuisé
		expect(hook.result.current.canUndo).toBe(false);
	});

	it("equals custom : compare uniquement `count`, ignore les autres champs", () => {
		const equals = vi.fn((a: State, b: State) => a.count === b.count);
		const { hook, ref } = setup({ count: 0 }, { equals });
		act(() => {
			hook.result.current.push();
		});
		// Change un champ NON pris en compte par equals → doit dédupe
		ref.current = { count: 0, label: "hello" };
		act(() => {
			hook.result.current.push();
		});
		// Un seul push effectif ⇒ un seul undo dispo
		act(() => {
			hook.result.current.undo();
		});
		expect(hook.result.current.canUndo).toBe(false);
		expect(equals).toHaveBeenCalled();
	});

	it("push ne fire pas pendant restore() (garde isRestoring)", () => {
		// Consommateur pathologique : restore() rappelle push() en cascade.
		// L'implémentation doit ignorer ce push pour ne pas polluer l'historique.
		const ref: { current: State } = { current: { count: 0 } };
		let hookRef: ReturnType<typeof useHistoryStack<State>> | null = null;
		const snapshot = vi.fn(() => ({ ...ref.current }));
		const restore = vi.fn((s: State) => {
			ref.current = { ...s };
			// Push depuis restore : doit être absorbé.
			hookRef?.push();
		});
		const hook = renderHook(() => {
			const h = useHistoryStack<State>({ snapshot, restore });
			hookRef = h;
			return h;
		});

		act(() => {
			hook.result.current.push();
		});
		ref.current = { count: 5 };
		act(() => {
			hook.result.current.push();
		});
		// past = [{0},{5}], undo devrait restore {0} ET absorber le push cascade
		act(() => {
			hook.result.current.undo();
		});
		// Si le push pendant restore avait été autorisé, il aurait clear future
		// et repoussé {0}. On vérifie que redo est toujours dispo :
		expect(hook.result.current.canRedo).toBe(true);
	});
});
