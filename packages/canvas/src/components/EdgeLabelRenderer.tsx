import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { canvasClass } from "../constants";
import { useNestStore } from "../context";
import type { CanvasState } from "../store";

const selector = (s: CanvasState) =>
	s.domNode?.querySelector<HTMLDivElement>(
		`.${canvasClass.edgeLabelRenderer}`
	) ?? null;

/**
 * Rend du HTML dans le calque transformé, au-dessus des edges et sous les
 * nodes (labels, poignées d'edge). Sans pointer-events par défaut.
 */
export function EdgeLabelRenderer({ children }: { children: ReactNode }) {
	const container = useNestStore(selector);
	if (container === null) return null;
	return createPortal(children, container);
}
