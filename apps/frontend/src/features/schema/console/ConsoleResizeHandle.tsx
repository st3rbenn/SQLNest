import { type CSSProperties, type PointerEvent, useRef, useState } from "react";
import { CONSOLE_HEIGHT_MIN, maxConsoleHeight } from "./useConsolePersistence";

interface Props {
	readonly height: number;
	readonly onHeightChange: (h: number) => void;
	readonly onResizingChange?: (resizing: boolean) => void;
}

/**
 * Poignée collée en haut de la console — drag vers le haut agrandit,
 * vers le bas réduit. Clampée entre MIN et maxConsoleHeight().
 * `onResizingChange` sert au parent à désactiver la transition CSS
 * pendant le drag (sinon lag visible).
 */
export function ConsoleResizeHandle({
	height,
	onHeightChange,
	onResizingChange
}: Props) {
	// Ref pour l'état du drag — immune aux closures stales entre pointermove.
	const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
	const [, setIsResizing] = useState(false);

	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		dragRef.current = { startY: e.clientY, startHeight: height };
		setIsResizing(true);
		onResizingChange?.(true);
	};
	const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
		if (!dragRef.current) return;
		const delta = dragRef.current.startY - e.clientY;
		const next = Math.max(
			CONSOLE_HEIGHT_MIN,
			Math.min(maxConsoleHeight(), dragRef.current.startHeight + delta)
		);
		onHeightChange(next);
	};
	const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
		if (!dragRef.current) return;
		try {
			(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		} catch {
			/* pointer déjà relâché */
		}
		dragRef.current = null;
		setIsResizing(false);
		onResizingChange?.(false);
	};

	return (
		<div
			style={handleStyle}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			role="separator"
			aria-orientation="horizontal"
			aria-label="Redimensionner la console"
		/>
	);
}

// Overlap sur les 6 premiers px du header (z-index supérieur). Curseur
// ns-resize signale l'affordance. Fond transparent pour ne pas encombrer.
const handleStyle: CSSProperties = {
	position: "absolute",
	top: 0,
	left: 0,
	right: 0,
	height: 6,
	cursor: "ns-resize",
	background: "transparent",
	zIndex: 6,
	touchAction: "none"
};
