import { useReactFlow } from "@xyflow/react";
import {
	type RefObject,
	startTransition,
	useEffect,
	useMemo,
	useRef
} from "react";
import type { LayoutResult } from "../layout";
import { NODE_WIDTH, nodeHeight } from "../TableNode";
import type { TableNodeType } from "../TableNode";
import {
	animateViewport,
	FOCUS_TWEEN_MS,
	FOCUS_ZOOM_MIN,
	focusZoom,
	OVERVIEW_FIT,
	overviewViewport,
	tablesBounds,
	type Viewport
} from "./viewport";

export interface SafeArea {
	readonly left: number;
	readonly right: number;
	readonly top: number;
	readonly bottom: number;
}

export interface UseCanvasViewportOptions {
	readonly base: LayoutResult | null;
	readonly nodes: readonly TableNodeType[];
	readonly containerRef: RefObject<HTMLDivElement | null>;
	/** Padding gauche dynamique (drawer docké ouvert ou pas). */
	readonly leftPadding: number;
	/** Hauteur courante de la console SNQL (publiée par
	 * `CanvasConsole.onHeightChange`). */
	readonly consoleHeight: number;
	/** Espace entre le bas de la toolbar et la console. */
	readonly consoleGap: number;
	readonly setFocusId: (id: string | null) => void;
}

export interface UseCanvasViewportReturn {
	/** Bandes occupées par les panels — le fit `overviewViewport` centre le
	 * schéma dans la zone libre. Le parent le passe aussi au drawer /
	 * console pour les positionner. */
	readonly safeArea: SafeArea;
	/** Focus + tween pan/zoom sur une table. Stratégie zoom-in-only : garde
	 * le zoom si déjà ≥ FOCUS_ZOOM_MIN, sinon zoom au seuil lisible. */
	readonly focusAndZoom: (id: string) => void;
	/** Retour à la vue aérienne (fit du bounding-box de toutes les tables). */
	readonly applyOverview: () => void;
}

/**
 * Gère TOUT ce qui touche au viewport React Flow :
 *   - Auto-fit initial au mount ELK + resize container (ResizeObserver),
 *     abandonné dès que l'user interagit (wheel/pan).
 *   - `focusAndZoom(id)` : pan animé + zoom-in vers une table (points
 *     d'entrée « distants » : arbre, palette Cmd+K, menu Détails).
 *   - `applyOverview()` : retour à la vue aérienne à la demande.
 *
 * ─── Pourquoi safeArea via ref plutôt que dep ────────────────────────
 * `safeArea` change quand le user toggle le drawer, ouvre TableDetails,
 * ou étend la console SNQL. Si on le met en dep du fit useEffect, chaque
 * changement recadre la vue — user perd sa position. On lit donc via ref,
 * frais uniquement quand le fit *légitime* tourne (mount + container
 * resize).
 *
 * ─── userTouched flag ────────────────────────────────────────────────
 * Une fois que l'user a wheel-zoomé ou pan-débuté sur la pane, l'auto-fit
 * s'arrête définitivement. Le flag est reset UNIQUEMENT quand `base`
 * change (nouveau schéma = nouvelle vue par défaut).
 */
export function useCanvasViewport(
	opts: UseCanvasViewportOptions
): UseCanvasViewportReturn {
	const {
		base,
		nodes,
		containerRef,
		leftPadding,
		consoleHeight,
		consoleGap,
		setFocusId
	} = opts;
	const { getViewport, setViewport } = useReactFlow();

	const safeArea = useMemo<SafeArea>(
		() => ({
			left: leftPadding,
			right: 8,
			top: 12,
			bottom: 68 + consoleHeight + consoleGap
		}),
		[consoleHeight, consoleGap, leftPadding]
	);

	// Voir doc du hook — `safeArea` volontairement HORS deps du fit effect.
	const safeAreaRef = useRef(safeArea);
	safeAreaRef.current = safeArea;
	const userTouchedViewportRef = useRef(false);
	// Handle du tween en cours — annulé si un nouveau focus arrive.
	const tweenRef = useRef<{ cancel: () => void } | null>(null);

	useEffect(() => {
		if (base === null) return;
		const el = containerRef.current;
		if (el === null) return;

		const fit = () => {
			if (userTouchedViewportRef.current) return;
			const rect = el.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return;
			const bounds = tablesBounds(base.nodes);
			if (bounds === null) return;
			setViewport(
				overviewViewport(bounds, rect, {
					padding: OVERVIEW_FIT.padding,
					maxZoom: OVERVIEW_FIT.maxZoom,
					minZoom: OVERVIEW_FIT.minZoom,
					safeArea: safeAreaRef.current
				})
			);
		};

		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, [base, setViewport, containerRef]);

	// Reset du flag "user touched" quand base change (nouveau schéma =
	// nouvelle vue par défaut, on ré-auto-fit jusqu'à interaction).
	useEffect(() => {
		userTouchedViewportRef.current = false;
	}, [base]);

	// Détecte les gestes viewport user (wheel = zoom, mousedown sur la
	// pane = début de pan). Une fois marqué, l'auto-fit s'arrête → la
	// vue de l'utilisateur est préservée sur les resize suivants.
	useEffect(() => {
		const el = containerRef.current;
		if (el === null) return;
		const markWheel = () => {
			userTouchedViewportRef.current = true;
		};
		const markPan = (e: PointerEvent) => {
			const t = e.target as HTMLElement | null;
			// Pan démarre depuis la pane vide (pas sur un nœud/edge/UI).
			if (t?.classList.contains("react-flow__pane")) {
				userTouchedViewportRef.current = true;
			}
		};
		el.addEventListener("wheel", markWheel, { passive: true });
		el.addEventListener("pointerdown", markPan);
		return () => {
			el.removeEventListener("wheel", markWheel);
			el.removeEventListener("pointerdown", markPan);
		};
	}, [containerRef]);

	const focusAndZoom = (id: string) => {
		const node = nodes.find((n) => n.id === id);
		if (!node || containerRef.current === null) {
			setFocusId(id);
			return;
		}
		const cx = node.position.x + (node.width ?? NODE_WIDTH) / 2;
		const cy =
			node.position.y + (node.height ?? nodeHeight(node.data.collection)) / 2;
		const from = getViewport();
		const zoom = focusZoom(from.zoom, { min: FOCUS_ZOOM_MIN });
		const rect = containerRef.current.getBoundingClientRect();
		const sa = safeAreaRef.current;
		const freeCenterX = sa.left + (rect.width - sa.left - sa.right) / 2;
		const freeCenterY = sa.top + (rect.height - sa.top - sa.bottom) / 2;
		const to: Viewport = {
			x: freeCenterX - cx * zoom,
			y: freeCenterY - cy * zoom,
			zoom
		};
		// Marque userTouched AVANT le tween : `setFocusId` change `safeArea`
		// (drawer droit ouvre → right passe de 8 à 352), ce qui déclenche le
		// `useEffect(fit, [safeArea])` — sans ce flag, ce fit écrase notre
		// tween par un retour à l'overview (bug « ça dezoom au click »).
		userTouchedViewportRef.current = true;
		tweenRef.current?.cancel();
		tweenRef.current = animateViewport(from, to, FOCUS_TWEEN_MS, setViewport);
		startTransition(() => setFocusId(id));
	};

	const applyOverview = () => {
		if (base === null || containerRef.current === null) return;
		const bounds = tablesBounds(base.nodes);
		if (bounds === null) return;
		const rect = containerRef.current.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		setViewport(
			overviewViewport(bounds, rect, {
				padding: OVERVIEW_FIT.padding,
				maxZoom: OVERVIEW_FIT.maxZoom,
				minZoom: OVERVIEW_FIT.minZoom,
				safeArea
			}),
			{ duration: OVERVIEW_FIT.duration }
		);
	};

	return { safeArea, focusAndZoom, applyOverview };
}
