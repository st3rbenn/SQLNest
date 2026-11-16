import { type RefObject, useEffect } from "react";

/** Après un défilement du contenu, la molette lui reste acquise ce délai :
 * arriver en bout de liste ne fait pas partir le canvas dans la foulée. */
const HOLD_MS = 250;

const SCROLLING = new Set(["auto", "scroll", "overlay"]);

function scrollsAlong(
	overflow: string,
	position: number,
	extent: number,
	viewport: number,
	delta: number
): boolean {
	if (delta === 0 || !SCROLLING.has(overflow) || extent <= viewport + 1) {
		return false;
	}
	return delta < 0 ? position > 0 : position + viewport < extent - 1;
}

/**
 * Vrai si un élément entre `target` et `boundary` peut encore défiler dans
 * le sens de la molette : c'est lui qui doit la recevoir, pas le canvas.
 */
export function contentScrolls(
	target: EventTarget | null,
	boundary: Element,
	deltaX: number,
	deltaY: number
): boolean {
	let el = target instanceof Element ? target : null;
	while (el !== null && boundary.contains(el)) {
		const style = getComputedStyle(el);
		if (
			scrollsAlong(
				style.overflowY,
				el.scrollTop,
				el.scrollHeight,
				el.clientHeight,
				deltaY
			) ||
			scrollsAlong(
				style.overflowX,
				el.scrollLeft,
				el.scrollWidth,
				el.clientWidth,
				deltaX
			)
		) {
			return true;
		}
		if (el === boundary) break;
		el = el.parentElement;
	}
	return false;
}

/**
 * Molette au-dessus d'un contenu posé sur le canvas : elle défile le contenu
 * quand il a de quoi défiler sous le pointeur, sinon elle déplace le canvas.
 * Le pinch (Ctrl + molette) zoome toujours le canvas.
 *
 * Écoute native : le moteur écoute la molette sur un ancêtre hors de React,
 * un `stopPropagation` synthétique arriverait après lui.
 */
export function useContentWheel(ref: RefObject<HTMLElement | null>): void {
	useEffect(() => {
		const holder = ref.current;
		if (holder === null) return;
		let heldUntil = 0;
		function onWheel(event: WheelEvent): void {
			if (event.ctrlKey || event.metaKey) return;
			if (
				holder !== null &&
				contentScrolls(event.target, holder, event.deltaX, event.deltaY)
			) {
				heldUntil = event.timeStamp + HOLD_MS;
				event.stopPropagation();
				return;
			}
			if (event.timeStamp < heldUntil) {
				event.stopPropagation();
				event.preventDefault();
			}
		}
		holder.addEventListener("wheel", onWheel, { passive: false });
		return () => holder.removeEventListener("wheel", onWheel);
	}, [ref]);
}
