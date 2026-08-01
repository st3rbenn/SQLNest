import { NODE_WIDTH, type TableNodeType } from "../TableNode";

/**
 * Vue aérienne cible.
 * - `maxZoom` cap le fit sur un petit sample (sinon cartes énormes à z ~= 1).
 * - `minZoom` PLANCHER : on ne descend jamais sous ce seuil, quitte à laisser
 *   des tables déborder hors du viewport. Règle produit : « on garde les
 *   cartes en mode garni (full) ; si tout ne rentre pas, tant pis, l'user
 *   peut pan ». 0.55 est calé juste au-dessus du seuil LOD `FULL_MIN` (0.5)
 *   avec une marge pour éviter de flirter avec la bascule vers `compact`.
 */
export const OVERVIEW_FIT: {
	padding: number;
	maxZoom: number;
	minZoom: number;
	duration: number;
} = {
	padding: 0.25,
	maxZoom: 0.6,
	minZoom: 0.55,
	duration: 400
};

// Zoom minimal après un focus-table. On ne dézoome JAMAIS : si l'utilisateur
// est déjà bien zoomé (> min), on garde son niveau, on ne fait que pan. S'il
// vient d'une vue aérienne (< min), on zoome IN jusqu'à ce seuil lisible.
// Modèle mental Figma : cliquer sur un élément = « aller le voir », pas « re-
// cadrer arbitrairement ».
export const FOCUS_ZOOM_MIN = 1;
export const FOCUS_TWEEN_MS = 350;

export interface Viewport {
	readonly x: number;
	readonly y: number;
	readonly zoom: number;
}

export interface ViewportSafeArea {
	readonly left?: number;
	readonly right?: number;
	readonly top?: number;
	readonly bottom?: number;
}

/**
 * Zoom initial adaptatif : quand RF ne peut pas calculer un fit propre au
 * mount (parent 0×0 pendant l'hydratation Mantine AppShell), on part d'un
 * zoom sensé basé sur la taille du schéma. Petit schéma → vue moyenne.
 * Gros schéma → vue **très** aérienne. `fitView` explicit prend le relais
 * dès que `useNodesInitialized` bascule.
 */
export function initialZoom(collectionCount: number): number {
	if (collectionCount <= 4) return 0.6;
	if (collectionCount <= 12) return 0.4;
	if (collectionCount <= 40) return 0.25;
	if (collectionCount <= 100) return 0.15;
	return 0.08;
}

/**
 * Anime le viewport en confiant le tween au moteur CSS via une transition
 * sur la transform de `.react-flow__viewport` — plutôt que du JS
 * frame-par-frame. Robuste face au throttling (embedded browsers, onglets
 * inactifs) car le composeur CSS tourne au niveau du navigateur, pas de
 * `setInterval`/`requestAnimationFrame`. Un handle `cancel()` retire la
 * transition prématurément si un nouveau focus arrive avant la fin.
 */
export function animateViewport(
	from: Viewport,
	to: Viewport,
	durationMs: number,
	apply: (v: Viewport) => void
): { cancel: () => void } {
	if (typeof document === "undefined") {
		apply(to);
		return { cancel: () => {} };
	}
	const vp = document.querySelector<HTMLElement>(".react-flow__viewport");
	// Pas de viewport = pas de canvas rendu → applique direct, pas d'animation.
	if (vp === null) {
		apply(to);
		return { cancel: () => {} };
	}
	// Applique la valeur `from` sans transition — sinon la 1ère transform
	// serait tweenée depuis n'importe quel état résiduel.
	vp.style.transition = "none";
	apply(from);
	// Force un reflow pour que le browser enregistre `from` avant transition.
	void vp.offsetWidth;
	vp.style.transition = `transform ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`;
	apply(to);
	const cleanup = () => {
		vp.style.transition = "";
	};
	const t = setTimeout(cleanup, durationMs + 50);
	return {
		cancel: () => {
			clearTimeout(t);
			cleanup();
		}
	};
}

/**
 * Zoom cible d'un focus-table. Pure → testable.
 * - currentZoom < min → min (zoom IN vers seuil lisible)
 * - currentZoom >= min → currentZoom (on ne dézoome jamais — respecte le
 *   niveau choisi par l'utilisateur)
 */
export function focusZoom(
	currentZoom: number,
	opts: { min: number }
): number {
	if (currentZoom < opts.min) return opts.min;
	return currentZoom;
}

/**
 * Bounds englobants de toutes les tables (frames exclus). Utilisé pour
 * calculer un viewport initial propre — `fitView` de React Flow refuse
 * de tourner tant que le conteneur parent n'est pas mesuré (warning
 * « needs a width and a height »), et sous Mantine `AppShell` cette
 * mesure arrive **après** l'hydratation. Pur → testable.
 */
export function tablesBounds(nodes: readonly TableNodeType[]): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
} | null {
	if (nodes.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of nodes) {
		const w = n.width ?? NODE_WIDTH;
		const h = n.height ?? 200;
		if (n.position.x < minX) minX = n.position.x;
		if (n.position.y < minY) minY = n.position.y;
		if (n.position.x + w > maxX) maxX = n.position.x + w;
		if (n.position.y + h > maxY) maxY = n.position.y + h;
	}
	return { minX, minY, maxX, maxY };
}

/**
 * Viewport qui centre les bounds dans la fenêtre visible avec un padding en %
 * et un zoom maxi. `safeArea` défalque les bandes occupées par les panels
 * flottants (drawer, toolbar) : le contenu se centre dans le rectangle libre,
 * pas dans le conteneur brut. Pure → testable.
 */
export function overviewViewport(
	bounds: { minX: number; minY: number; maxX: number; maxY: number },
	container: { width: number; height: number },
	options: {
		padding: number;
		maxZoom: number;
		minZoom?: number;
		safeArea?: ViewportSafeArea;
	}
): { x: number; y: number; zoom: number } {
	const safeLeft = options.safeArea?.left ?? 0;
	const safeRight = options.safeArea?.right ?? 0;
	const safeTop = options.safeArea?.top ?? 0;
	const safeBottom = options.safeArea?.bottom ?? 0;
	const freeW = Math.max(1, container.width - safeLeft - safeRight);
	const freeH = Math.max(1, container.height - safeTop - safeBottom);
	const contentW = bounds.maxX - bounds.minX;
	const contentH = bounds.maxY - bounds.minY;
	const pad = options.padding;
	const availW = freeW * (1 - 2 * pad);
	const availH = freeH * (1 - 2 * pad);
	const zoom = Math.max(
		options.minZoom ?? 0.02,
		Math.min(options.maxZoom, availW / contentW, availH / contentH)
	);
	const centerX = (bounds.minX + bounds.maxX) / 2;
	const centerY = (bounds.minY + bounds.maxY) / 2;
	const freeCenterX = safeLeft + freeW / 2;
	const freeCenterY = safeTop + freeH / 2;
	return {
		x: freeCenterX - centerX * zoom,
		y: freeCenterY - centerY * zoom,
		zoom
	};
}
