import { KindBadge, TypePill } from "@sqlnest/design-system";
import {
	Handle,
	type Node,
	type NodeProps,
	Position,
	useStore
} from "@xyflow/react";
import type { CSSProperties } from "react";
import { colorFor } from "./colors";
import type { Collection } from "./schema-model";
import { levelForZoom, type ZoomLevel } from "./zoomLevel";

/** Nombre de champs affichés avant repli (garde des nœuds de hauteur bornée). */
export const MAX_FIELDS = 12;
export const NODE_WIDTH = 240;
const HEADER_H = 44;
const ROW_H = 20;
const PAD = 10;

/** Hauteur d'un nœud table, dérivée du nombre de champs (stable → layout stable). */
export function nodeHeight(collection: Collection): number {
	const shown = Math.min(collection.fields.length, MAX_FIELDS);
	const more = collection.fields.length > MAX_FIELDS ? ROW_H : 0;
	return HEADER_H + shown * ROW_H + more + PAD;
}

export interface TableNodeData {
	readonly collection: Collection;
	/** Estompé (hors focus / hors recherche). */
	readonly dimmed: boolean;
	/** Nœud focalisé (cliqué). */
	readonly focused: boolean;
	/** Correspond à la recherche courante. */
	readonly matched: boolean;
	readonly [key: string]: unknown;
}

export type TableNodeType = Node<TableNodeData, "table">;

const HIDDEN_HANDLE: CSSProperties = { opacity: 0, border: "none" };

/**
 * Sélecteur Zustand : (zoom brut quantifié à 0.01 + level dérivé). Le zoom
 * brut sert à compenser la font-size (inversement proportionnelle) pour que
 * les noms restent lisibles au zoom out. Quantification → réduit les re-renders
 * de ~100× (une seule fois par 0.01 de zoom).
 */
const zoomSelector = (s: {
	transform: readonly [number, number, number];
}): { zoom: number; level: ZoomLevel } => {
	const raw = s.transform[2];
	const quantized = Math.round(raw * 100) / 100;
	return { zoom: quantized, level: levelForZoom(quantized) };
};

/** Font-size world coord pour un nom lisible à l'écran quel que soit le zoom.
 *  Cible ~ 14 px écran (`14 / zoom`), clampée pour rester raisonnable
 *  aux extrêmes (jamais < 13, jamais > 180). */
function nameFont(zoom: number, base = 14, min = 13, max = 180): number {
	if (zoom <= 0) return min;
	return Math.min(max, Math.max(min, base / zoom));
}

export function TableNode({ data }: NodeProps<TableNodeType>) {
	const { collection, dimmed, focused, matched } = data;
	const { zoom, level } = useStore(zoomSelector);
	const inferred = collection.source === "inferred";
	const color = colorFor(collection.name);
	const height = nodeHeight(collection);

	// Enveloppe commune : border colorée (bleu/ambre override en focus/match),
	// ombre focus/match, gestion `dimmed`. LOD variants remplissent l'enveloppe
	// à la taille RÉELLE (NODE_WIDTH × nodeHeight) — sinon les handles (aux
	// bords du wrapper RF) ne s'alignent plus avec le visuel à faible zoom.
	const shellStyle: CSSProperties = {
		width: NODE_WIDTH,
		height,
		borderRadius: 10,
		background: "#fff",
		border: `2px solid ${matched ? "#f59e0b" : focused ? "#2563eb" : color.border}`,
		boxShadow: focused
			? "0 0 0 3px rgba(37,99,235,0.25), 0 8px 24px rgba(15,23,42,0.12)"
			: matched
				? "0 0 0 3px rgba(245,158,11,0.3)"
				: "0 1px 3px rgba(15,23,42,0.08)",
		opacity: dimmed ? 0.28 : 1,
		transition: "opacity 120ms, box-shadow 120ms",
		overflow: "hidden",
		fontFamily: "ui-sans-serif, system-ui, sans-serif"
	};

	// ── LOD level 4 : dot (zoom < 0.1) ────────────────────────────────
	// Wrapper rempli d'une couleur solide, pas de texte. Arrows attachés
	// aux bords (comme les autres levels).
	if (level === "dot") {
		return (
			<div
				style={{
					...shellStyle,
					background: color.border
				}}
			>
				<Handle type="target" position={Position.Left} style={HIDDEN_HANDLE} />
				<Handle type="source" position={Position.Right} style={HIDDEN_HANDLE} />
			</div>
		);
	}

	// ── LOD level 3 : pill (0.1 ≤ zoom < 0.2) ─────────────────────────
	// Wrapper rempli couleur.header, nom centré en gros (font-size ~ 14/zoom
	// pour rester lisible ≈ 14 px écran).
	if (level === "pill") {
		return (
			<div
				style={{
					...shellStyle,
					background: color.header,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					padding: "0 16px"
				}}
			>
				<Handle type="target" position={Position.Left} style={HIDDEN_HANDLE} />
				<span
					style={{
						fontSize: nameFont(zoom, 14, 40, 140),
						fontWeight: 800,
						color: color.text,
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
						textAlign: "center",
						width: "100%"
					}}
				>
					{collection.name}
				</span>
				<Handle type="source" position={Position.Right} style={HIDDEN_HANDLE} />
			</div>
		);
	}

	// ── LOD level 2 : compact (0.2 ≤ zoom < 0.5) ──────────────────────
	// Header seul (nom fs compensé + kind badge) — la carte reste à sa taille
	// pleine pour que les arrows collent au bord.
	if (level === "compact") {
		return (
			<div style={{ ...shellStyle, background: color.header }}>
				<Handle type="target" position={Position.Left} style={HIDDEN_HANDLE} />
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 8,
						padding: "10px 12px",
						height: "100%"
					}}
				>
					<span
						style={{
							fontWeight: 700,
							fontSize: nameFont(zoom, 14, 18, 60),
							color: color.text,
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis"
						}}
					>
						{collection.name}
					</span>
					<KindBadge kind={inferred ? "inferred" : "declared"} />
				</div>
				<Handle type="source" position={Position.Right} style={HIDDEN_HANDLE} />
			</div>
		);
	}

	// ── LOD level 1 : full (zoom ≥ 0.5) ───────────────────────────────
	const pk = new Set(collection.primaryKey ?? []);
	const shown = collection.fields.slice(0, MAX_FIELDS);
	const hidden = collection.fields.length - shown.length;
	return (
		<div style={shellStyle}>
			<Handle type="target" position={Position.Left} style={HIDDEN_HANDLE} />
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 8,
					padding: "10px 12px",
					borderBottom: `1px solid ${color.border}`,
					background: color.header
				}}
			>
				<span
					style={{
						fontWeight: 700,
						fontSize: 13,
						color: color.text,
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis"
					}}
				>
					{collection.name}
				</span>
				<KindBadge kind={inferred ? "inferred" : "declared"} />
			</div>
			<div style={{ padding: "4px 0" }}>
				{shown.map((f) => (
					<div
						key={f.name}
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 8,
							height: ROW_H,
							padding: "0 12px",
							fontSize: 11.5
						}}
					>
						<span
							style={{
								display: "flex",
								alignItems: "center",
								gap: 5,
								color: "#334155",
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis"
							}}
						>
							{pk.has(f.name) ? <KindBadge kind="pk" /> : null}
							{f.name}
						</span>
						<TypePill type={f.type} nullable={f.nullable} />
					</div>
				))}
				{hidden > 0 ? (
					<div
						style={{
							height: ROW_H,
							padding: "0 12px",
							fontSize: 10.5,
							color: "#cbd5e1",
							display: "flex",
							alignItems: "center"
						}}
					>
						+{hidden} champ{hidden > 1 ? "s" : ""}…
					</div>
				) : null}
			</div>
			<Handle type="source" position={Position.Right} style={HIDDEN_HANDLE} />
		</div>
	);
}
