import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useMemo, useRef } from "react";
import type { PreviewSnapshot } from "../db-connections/useDbConnections";
import { deserialize } from "../schema/canvas/canvasPayload";
import {
	type CanvasStateGetResponse,
	fetchCanvasState
} from "../schema/canvas/canvasStateClient";
import { colorFor } from "../schema/colors";
import {
	buildPreviewLayout,
	PREVIEW_NODE_H,
	PREVIEW_NODE_W,
	type PreviewLayoutResult
} from "../schema/layout";
import type { SchemaModel } from "../schema/schema-model";
import { useSchema } from "../schema/useSchema";

/**
 * Preview miniature d'un schéma pour les cards de la gallery.
 *
 * ─── Source du layout (2 modes) ──────────────────────────────────────
 *   1. Si un canvas_state serveur existe pour cette connection (l'user a
 *      déjà bougé/persisté ses tables) → on utilise SES positions/sizes.
 *      La preview reflète alors LITTÉRALEMENT ce que l'user voit dans le
 *      canvas — un vrai zoom-out fidèle.
 *   2. Sinon (jamais save) → fallback sur `buildPreviewLayout` (ELK dense
 *      avec node dims fixes). Résultat propre, générique, hors-user.
 *
 * Les 2 layouts partagent le même cache TanStack Query
 * (`["canvas-state", id]` et `["schema-preview-layout", key]`) — un PUT
 * depuis le canvas met à jour le cache canvas_state via `setQueryData`,
 * la preview se re-render automatiquement.
 *
 * ─── Rendu SVG static ────────────────────────────────────────────────
 * `viewBox = bbox layout + padding`, `preserveAspectRatio="xMidYMid meet"`
 * → scale automatique dans le wrapper 16:10.
 *
 * ─── isOnline ─────────────────────────────────────────────────────────
 * Passé par le parent depuis `useDbConnections` (poll 5s). Contrôle :
 *   - `false` → n'appelle PAS `useSchema` → "CLI hors ligne"
 *   - transition `false→true` (reconnect CLI) → invalide `["schema", id]`.
 */

interface Props {
	readonly connectionId: string;
	readonly isOnline: boolean;
	/** Snapshot persisté du dernier rendu (C.15). Utilisé comme fallback
	 *  quand `isOnline === false` — au lieu d'afficher « CLI hors ligne »
	 *  vide, on re-render depuis le snapshot (theme-aware).
	 *  `null` si l'user n'a jamais save le canvas de cette connection. */
	readonly snapshot?: PreviewSnapshot | null;
}

const wrapperStyle: CSSProperties = {
	position: "relative",
	aspectRatio: "16 / 10",
	background: "var(--sqlnest-canvas-bg)",
	overflow: "hidden"
};

const centerMessageStyle: CSSProperties = {
	position: "absolute",
	inset: 0,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	fontSize: 11,
	color: "var(--sqlnest-text-tertiary)",
	fontFamily: "var(--mantine-font-family-monospace)"
};

/** Padding autour de la bbox — évite que les tables touchent les bords. */
const BBOX_PAD = 20;

/** Loading skeleton — bloc uni qui remplit la zone preview avec un shimmer
 *  gradient qui glisse de gauche à droite. Pattern classique : un
 *  placeholder discret sans essayer de deviner le contenu final. Le
 *  gradient utilise trois stops gris fin (base → highlight → base) sur un
 *  background-size 200 % → l'animation `background-position` de 200 % à
 *  -200 % fait glisser le highlight en travers en 1.6 s.
 *
 *  Palette : `hsla(0, 0%, 100%, 0.04)` en base, `0.09` au pic — rest
 *  parfaitement lisible sur le fond `--sqlnest-canvas-bg` sans jamais
 *  attirer l'œil. */
function PreviewSkeleton(): React.ReactNode {
	return (
		<div
			style={{
				position: "absolute",
				inset: 0,
				background:
					"linear-gradient(90deg, hsla(0,0%,100%,0.04) 0%, hsla(0,0%,100%,0.04) 40%, hsla(0,0%,100%,0.09) 50%, hsla(0,0%,100%,0.04) 60%, hsla(0,0%,100%,0.04) 100%)",
				backgroundSize: "200% 100%",
				animation: "sqlnest-skeleton-shimmer 1.6s linear infinite"
			}}
			aria-hidden="true"
		/>
	);
}

export function MiniSchemaPreview({ connectionId, isOnline, snapshot }: Props) {
	const queryClient = useQueryClient();
	const {
		data: schema,
		error,
		isLoading
	} = useSchema(isOnline ? connectionId : null);

	const prevOnlineRef = useRef(isOnline);
	useEffect(() => {
		if (!prevOnlineRef.current && isOnline) {
			void queryClient.invalidateQueries({
				queryKey: ["schema", connectionId]
			});
		}
		prevOnlineRef.current = isOnline;
	}, [isOnline, connectionId, queryClient]);

	// PRIORITÉ ABSOLUE au snapshot précalculé (C.15 → C.18). Le snapshot
	// est capturé à partir du VRAI état du canvas (positions RF + frames +
	// hidden), donc la preview affiche EXACTEMENT ce que l'user voit dans
	// le canvas — pas de divergence par ELK settings différents.
	//
	// Sans ce shortcut, `PreviewSvg` recalcule via canvas_state (positions
	// user si complètes) OU ELK dense (buildPreviewLayout) qui diffère du
	// buildLayout du canvas. Un canvas partiellement bougé + reste en ELK
	// standard produisait deux vues incohérentes. Bug rapporté 2026-08-07.
	//
	// C.19 : quand CLI offline mais snapshot dispo, on garde la preview
	// et on ajoute un badge « hors ligne » discret en top-right. L'user
	// voit ce qu'il connaît + le status, au lieu d'un « CLI hors ligne »
	// qui masque tout.
	if (snapshot && snapshot.nodes.length > 0) {
		return (
			<div style={wrapperStyle}>
				<PreviewSvgFromSnapshot snapshot={snapshot} />
				{!isOnline ? <OfflineBadge /> : null}
			</div>
		);
	}

	// Pas de snapshot (jamais save) : fallback selon l'état CLI.
	if (!isOnline) {
		return (
			<div style={wrapperStyle}>
				<div style={centerMessageStyle}>CLI hors ligne</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div style={wrapperStyle}>
				<PreviewSkeleton />
			</div>
		);
	}

	if (error || !schema) {
		return (
			<div style={wrapperStyle}>
				<div style={centerMessageStyle}>Aperçu indisponible</div>
			</div>
		);
	}

	return (
		<div style={wrapperStyle}>
			<PreviewSvg schema={schema} connectionId={connectionId} />
		</div>
	);
}

/** Badge discret en top-right qui signale que le CLI n'est plus connecté,
 *  affiché EN OVERLAY sur la preview snapshot pour ne pas la masquer.
 *  Palette : dot orange (statut warning, pas erreur), pill semi-opaque
 *  sur fond dark, texte minuscule. L'user comprend en un coup d'œil
 *  « tu vois un snapshot, pas du live ». */
function OfflineBadge(): React.ReactNode {
	return (
		<div
			style={{
				position: "absolute",
				top: 8,
				right: 8,
				display: "inline-flex",
				alignItems: "center",
				gap: 5,
				padding: "3px 8px",
				borderRadius: 999,
				background: "hsla(0, 0%, 0%, 0.55)",
				border: "1px solid var(--sqlnest-border-subtle)",
				fontSize: 10,
				fontWeight: 600,
				color: "var(--sqlnest-text-secondary)",
				letterSpacing: "0.2px",
				pointerEvents: "none",
				backdropFilter: "blur(4px)"
			}}
			aria-label="CLI hors ligne — aperçu du dernier état connu"
		>
			<span
				style={{
					width: 5,
					height: 5,
					borderRadius: "50%",
					background: "hsl(30, 90%, 55%)"
				}}
			/>
			Hors ligne
		</div>
	);
}

/** Fetch canvas_state (positions user) — partage le MÊME cache TanStack
 *  que useCanvasSync du canvas. Un PUT depuis le canvas met à jour ce
 *  cache via setQueryData → la preview re-render aussi. */
function useUserCanvasState(connectionId: string) {
	return useQuery<CanvasStateGetResponse | null>({
		queryKey: ["canvas-state", connectionId],
		queryFn: () => fetchCanvasState(connectionId),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		retry: false,
		refetchOnMount: false,
		refetchOnWindowFocus: false
	});
}

/** Fallback ELK — invoqué uniquement quand aucun canvas_state serveur. */
function useSchemaElkLayout(schema: SchemaModel) {
	const key = useMemo(() => {
		const names = schema.collections
			.map((c) => c.name)
			.slice()
			.sort()
			.join(",");
		return `${schema.engine}:${names}`;
	}, [schema]);

	return useQuery<PreviewLayoutResult>({
		queryKey: ["schema-preview-layout", key],
		queryFn: () => buildPreviewLayout(schema),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		retry: false,
		refetchOnMount: false,
		refetchOnWindowFocus: false
	});
}

function PreviewSvg({
	schema,
	connectionId
}: {
	readonly schema: SchemaModel;
	readonly connectionId: string;
}): React.ReactNode {
	const { data: canvasState } = useUserCanvasState(connectionId);
	const { data: elkLayout } = useSchemaElkLayout(schema);

	// Choix du layout : user > ELK fallback.
	const layout = useMemo<PreviewLayoutResult | null>(() => {
		if (canvasState?.payload) {
			const built = buildLayoutFromUserState(schema, canvasState.payload);
			// Si TOUTES les tables ont une position user, on utilise this.
			// Sinon on n'a qu'un partial → fallback ELK (évite tables collées
			// à (0,0) faute d'entrée dans le payload).
			if (built.nodes.length === schema.collections.length) return built;
		}
		return elkLayout ?? null;
	}, [canvasState, elkLayout, schema]);

	// Frames — uniquement si layout provient du canvas_state user (les
	// frames n'ont pas de sens dans le fallback ELK où positions ≠ celles
	// de l'user). Résout `rect` explicite OU bbox calculée depuis les
	// tables membres.
	const frames = useMemo(() => {
		if (!canvasState?.payload || !layout) return [];
		return buildFramesForPreview(canvasState.payload, layout);
	}, [canvasState, layout]);

	const view = useMemo(() => {
		if (!layout || layout.nodes.length === 0) return null;
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const n of layout.nodes) {
			if (n.x < minX) minX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.x + n.w > maxX) maxX = n.x + n.w;
			if (n.y + n.h > maxY) maxY = n.y + n.h;
		}
		// Étend la bbox pour englober les frames — sinon un frame qui
		// déborde des tables (padding user) serait clippé.
		for (const f of frames) {
			if (f.x < minX) minX = f.x;
			if (f.y < minY) minY = f.y;
			if (f.x + f.w > maxX) maxX = f.x + f.w;
			if (f.y + f.h > maxY) maxY = f.y + f.h;
		}
		// Réserve de l'espace vertical au-dessus pour les badges de frame
		// (rendus externes au cadre). Approximation basée sur la largeur du
		// viewBox — sans data spécifique aux badges à ce stade, un padding
		// haut supplémentaire ~4% suffit à les garder visibles.
		const w = maxX - minX + BBOX_PAD * 2;
		const badgeReserve = frames.length > 0 ? w * 0.05 : 0;
		return {
			x: minX - BBOX_PAD,
			y: minY - BBOX_PAD - badgeReserve,
			w,
			h: maxY - minY + BBOX_PAD * 2 + badgeReserve
		};
	}, [layout, frames]);

	// Layout ELK / canvas_state en cours de résolution → fallback skeleton
	// pour éviter un flick de wrapper vide entre l'état isLoading (skeleton
	// affiché par MiniSchemaPreview) et le rendu final. `useSchema` a settle
	// mais `useSchemaElkLayout` / `useUserCanvasState` sont encore pending.
	if (!layout || !view) return <PreviewSkeleton />;
	return <PreviewSvgBody layout={layout} frames={frames} view={view} />;
}

/** Composant SVG PUR — pas de hooks, reçoit un layout + frames + view
 *  déjà calculés et rend. Utilisé pour les 2 sources (canvas_state user
 *  et snapshot persisté).
 *
 *  Extrait de `PreviewSvg` pour permettre à `PreviewSvgFromSnapshot`
 *  (mode CLI offline) de réutiliser le même rendu sans dupliquer le SVG. */
function PreviewSvgBody({
	layout,
	frames,
	view
}: {
	readonly layout: PreviewLayoutResult;
	readonly frames: readonly PreviewFrame[];
	readonly view: { x: number; y: number; w: number; h: number };
}): React.ReactNode {
	const nodesByName = new Map(layout.nodes.map((n) => [n.id, n]));
	// FontSize dynamique pour les labels de frame : la preview scale
	// automatiquement pour fit le wrapper 16:10 → un fontSize constant en
	// unités SVG deviendrait illisible sur les gros schémas (viewBox large).
	// On l'accroche à `view.w` avec un clamp pour garder ~11-14px à l'écran.
	const labelFontSize = Math.max(11, Math.min(view.w * 0.028, 34));
	const labelPadX = labelFontSize * 0.7;
	const labelHeight = labelFontSize * 1.55;
	const labelCharW = labelFontSize * 0.55;

	return (
		<svg
			viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
			preserveAspectRatio="xMidYMid meet"
			style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
			aria-hidden="true"
		>
			<title>Aperçu du schéma</title>
			{/* Frames en arrière-plan — mêmes couleurs `hsla(hue, ...)` que
			    FrameNode du canvas pour cohérence visuelle. Rendus SOUS les
			    edges et tables. */}
			{frames.map((f) => (
				<g key={f.key}>
					<rect
						x={f.x}
						y={f.y}
						width={f.w}
						height={f.h}
						rx={12}
						fill={`hsla(${f.hue}, 60%, 45%, 0.12)`}
						stroke={`hsl(${f.hue}, 55%, 55%)`}
						strokeWidth={1.4}
					/>
				</g>
			))}
			{layout.edges.map((e, i) => {
				const from = nodesByName.get(e.source);
				const to = nodesByName.get(e.target);
				if (!from || !to) return null;
				return (
					<line
						// biome-ignore lint/suspicious/noArrayIndexKey: edges list stable côté layout
						key={`e-${i}`}
						x1={from.x + from.w / 2}
						y1={from.y + from.h / 2}
						x2={to.x + to.w / 2}
						y2={to.y + to.h / 2}
						stroke="var(--sqlnest-accent)"
						strokeWidth={1}
						strokeOpacity={0.35}
					/>
				);
			})}
			{layout.nodes.map((n) => {
				const color = colorFor(n.id);
				return (
					<g key={n.id}>
						<rect
							x={n.x}
							y={n.y}
							width={n.w}
							height={n.h}
							rx={4}
							fill={color.header}
							stroke={color.border}
							strokeWidth={1.4}
						/>
						<text
							x={n.x + n.w / 2}
							y={n.y + n.h / 2 + 4}
							textAnchor="middle"
							fontSize={12}
							fontWeight={600}
							fill={color.text}
							style={{
								fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif"
							}}
						>
							{truncate(n.id, 14)}
						</text>
					</g>
				);
			})}
			{/* Badges externes des frames — rendus EN DERNIER pour rester
			    au-dessus des tables/edges quand ils débordent visuellement
			    sur les rects. Positionnés au-dessus de l'edge supérieur du
			    frame, style pill solide pour rester lisible sur tous fonds. */}
			{frames.map((f) => {
				if (!f.label) return null;
				const truncated = truncate(f.label, 24);
				const badgeW = truncated.length * labelCharW + labelPadX * 2;
				const badgeX = f.x;
				const badgeY = f.y - labelHeight - 2;
				return (
					<g key={`badge-${f.key}`}>
						<rect
							x={badgeX}
							y={badgeY}
							width={badgeW}
							height={labelHeight}
							rx={labelHeight / 2}
							fill={`hsl(${f.hue}, 55%, 35%)`}
						/>
						<text
							x={badgeX + labelPadX}
							y={badgeY + labelHeight * 0.68}
							fontSize={labelFontSize}
							fontWeight={700}
							fill="var(--sqlnest-text-primary)"
							style={{
								fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
								letterSpacing: "0.2px"
							}}
						>
							{truncated}
						</text>
					</g>
				);
			})}
		</svg>
	);
}

/** Rend un snapshot persisté (C.15). Utilisé comme fallback quand le CLI
 *  est offline — le snapshot contient déjà nodes/edges/frames précalculés,
 *  on n'a qu'à mapper vers les types internes + calculer la bbox de la
 *  vue. Theme-aware (couleurs calculées via `colorFor`, pas stockées). */
function PreviewSvgFromSnapshot({
	snapshot
}: {
	readonly snapshot: PreviewSnapshot;
}): React.ReactNode {
	const layout: PreviewLayoutResult = useMemo(
		() => ({
			nodes: snapshot.nodes.map((n) => ({
				id: n.id,
				x: n.x,
				y: n.y,
				w: n.w,
				h: n.h
			})),
			edges: snapshot.edges.map((e) => ({ source: e.source, target: e.target }))
		}),
		[snapshot]
	);
	const frames: readonly PreviewFrame[] = useMemo(
		() =>
			snapshot.frames.map((f) => ({
				key: f.key,
				label: f.label,
				hue: f.hue,
				x: f.x,
				y: f.y,
				w: f.w,
				h: f.h
			})),
		[snapshot]
	);
	const view = useMemo(() => {
		if (layout.nodes.length === 0) return null;
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const n of layout.nodes) {
			if (n.x < minX) minX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.x + n.w > maxX) maxX = n.x + n.w;
			if (n.y + n.h > maxY) maxY = n.y + n.h;
		}
		for (const f of frames) {
			if (f.x < minX) minX = f.x;
			if (f.y < minY) minY = f.y;
			if (f.x + f.w > maxX) maxX = f.x + f.w;
			if (f.y + f.h > maxY) maxY = f.y + f.h;
		}
		const w = maxX - minX + BBOX_PAD * 2;
		const badgeReserve = frames.length > 0 ? w * 0.05 : 0;
		return {
			x: minX - BBOX_PAD,
			y: minY - BBOX_PAD - badgeReserve,
			w,
			h: maxY - minY + BBOX_PAD * 2 + badgeReserve
		};
	}, [layout, frames]);

	// Snapshot avec 0 nodes → skeleton plutôt que wrapper vide (le caller filtre
	// déjà `nodes.length > 0` mais on garde le fallback pour robustesse).
	if (!view) return <PreviewSkeleton />;
	return <PreviewSvgBody layout={layout} frames={frames} view={view} />;
}

/** Convertit un canvas_state payload (positions/sizes user) en
 *  PreviewLayoutResult. Ignore silencieusement les tables sans position
 *  dans le payload — le caller décide du fallback via le check `nodes.length`. */
function buildLayoutFromUserState(
	schema: SchemaModel,
	payload: Record<string, unknown>
): PreviewLayoutResult {
	const sources = deserialize(payload);
	const nodes = [];
	for (const c of schema.collections) {
		const pos = sources.positions[c.name];
		if (!pos) continue;
		const size = sources.sizes[c.name];
		nodes.push({
			id: c.name,
			x: pos.x,
			y: pos.y,
			w: size?.width ?? PREVIEW_NODE_W,
			h: size?.height ?? PREVIEW_NODE_H
		});
	}
	const nodeNames = new Set(nodes.map((n) => n.id));
	const edges = schema.relations
		.filter(
			(r) => nodeNames.has(r.from.collection) && nodeNames.has(r.to.collection)
		)
		.map((r) => ({
			source: r.from.collection,
			target: r.to.collection
		}));
	return { nodes, edges };
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}

interface PreviewFrame {
	readonly key: string;
	readonly label: string;
	readonly hue: number;
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

/** Résout les frames depuis le canvas_state payload. `rect` explicite si
 *  présent, sinon bbox des collections membres (comme le canvas quand
 *  frame.rect est absent — frames-seed hérités). */
function buildFramesForPreview(
	payload: Record<string, unknown>,
	layout: PreviewLayoutResult
): readonly PreviewFrame[] {
	const sources = deserialize(payload);
	const nodesByName = new Map(layout.nodes.map((n) => [n.id, n]));
	const out: PreviewFrame[] = [];
	for (const f of sources.frames) {
		if (f.rect) {
			out.push({
				key: f.key,
				label: f.label,
				hue: f.hue,
				x: f.rect.x,
				y: f.rect.y,
				w: f.rect.width,
				h: f.rect.height
			});
			continue;
		}
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		let seen = false;
		for (const name of f.collections) {
			const n = nodesByName.get(name);
			if (!n) continue;
			seen = true;
			if (n.x < minX) minX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.x + n.w > maxX) maxX = n.x + n.w;
			if (n.y + n.h > maxY) maxY = n.y + n.h;
		}
		if (!seen) continue;
		const PAD = 16;
		out.push({
			key: f.key,
			label: f.label,
			hue: f.hue,
			x: minX - PAD,
			y: minY - PAD,
			w: maxX - minX + PAD * 2,
			h: maxY - minY + PAD * 2
		});
	}
	return out;
}
