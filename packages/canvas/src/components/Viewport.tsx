import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { canvasClass } from "../constants";
import { useStoreApi } from "../context";
import type { Transform } from "../types";

export const transformString = ([x, y, k]: Transform): string =>
	`translate(${x}px,${y}px) scale(${k})`;

/**
 * Calque transformé qui porte nodes et edges. La transform est écrite
 * directement dans le DOM à chaque changement : pan/zoom ne re-rend pas React.
 */
export function Viewport({ children }: { children: ReactNode }) {
	const store = useStoreApi();
	const ref = useRef<HTMLDivElement>(null);
	const [initial] = useState(() => store.getState().transform);

	useLayoutEffect(() => {
		store.setState({ viewportNode: ref.current });
		let prev: Transform | null = null;
		const apply = () => {
			const t = store.getState().transform;
			if (
				prev !== null &&
				t[0] === prev[0] &&
				t[1] === prev[1] &&
				t[2] === prev[2]
			)
				return;
			prev = t;
			if (ref.current) ref.current.style.transform = transformString(t);
		};
		apply();
		return store.subscribe(apply);
	}, [store]);

	return (
		<div
			ref={ref}
			className={`${canvasClass.viewport} ${canvasClass.container}`}
			style={{ transform: transformString(initial) }}
		>
			{children}
		</div>
	);
}
