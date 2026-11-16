import { useState } from "react";
import type { ResizableDrawerHandleProps } from "./CanvasContext";
import { useResizableDrawer } from "./DrawerPane";

const DRAWER_GAP = 8;

export interface UseLeftDrawerReturn {
	readonly visible: boolean;
	readonly setVisible: (v: boolean | ((prev: boolean) => boolean)) => void;
	readonly width: number;
	readonly handleProps: ResizableDrawerHandleProps;
	/** Bande gauche occupée : le fit du canvas l'évite. */
	readonly leftPadding: number;
}

/**
 * Drawer gauche : masqué à l'arrivée (état non persisté, il revient à sa
 * position par défaut à chaque rechargement), largeur réglable et gardée.
 */
export function useLeftDrawer(): UseLeftDrawerReturn {
	const [visible, setVisible] = useState(false);
	const { width, handleProps } = useResizableDrawer();
	return {
		visible,
		setVisible,
		width,
		handleProps,
		leftPadding: visible ? width + DRAWER_GAP : DRAWER_GAP
	};
}
