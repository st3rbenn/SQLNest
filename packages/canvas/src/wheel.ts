export const isMacOs = (): boolean =>
	typeof navigator !== "undefined" && navigator.userAgent.indexOf("Mac") >= 0;

type WheelLike = Pick<
	WheelEvent,
	"deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "shiftKey"
>;

/**
 * Exposant de zoom d'un événement wheel : `zoom × 2^delta`. Le pinch trackpad
 * macOS arrive en wheel + `ctrlKey` avec des deltas minuscules, d'où le ×10.
 */
export function wheelZoomExponent(event: WheelLike, mac = isMacOs()): number {
	const factor = event.ctrlKey && mac ? 10 : 1;
	const unit = event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002;
	return -event.deltaY * unit * factor;
}

/**
 * Déplacement écran (px) d'un wheel en mode pan. Firefox émet en lignes
 * (`deltaMode = 1`) → ×20. Hors macOS, Shift+molette = pan horizontal.
 */
export function panOnScrollDelta(
	event: WheelLike,
	speed: number,
	mac = isMacOs()
): [number, number] {
	const normalize = event.deltaMode === 1 ? 20 : 1;
	let dx = event.deltaX * normalize;
	let dy = event.deltaY * normalize;
	if (!mac && event.shiftKey) {
		dx = event.deltaY * normalize;
		dy = 0;
	}
	return [-dx * speed, -dy * speed];
}
