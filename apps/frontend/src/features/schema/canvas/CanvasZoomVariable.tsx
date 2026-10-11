import { useNestStore } from "@sqlnest/canvas";
import { useLayoutEffect } from "react";

/**
 * Pose le zoom courant en variable CSS `--canvas-zoom` sur le canvas : le
 * CSS peut garder une taille constante à l'écran sans re-rendre les nodes
 * à chaque cran de zoom.
 */
export function CanvasZoomVariable() {
	const zoom = useNestStore((s) => s.transform[2]);
	const domNode = useNestStore((s) => s.domNode);
	useLayoutEffect(() => {
		domNode?.style.setProperty("--canvas-zoom", String(zoom));
	}, [domNode, zoom]);
	return null;
}
