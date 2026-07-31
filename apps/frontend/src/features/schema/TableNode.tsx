import { Tooltip } from "@mantine/core";
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
 * Sélecteur Zustand : niveau LOD dérivé du zoom courant. On ne remonte QUE
 * le niveau (pas le zoom brut) — la node se re-render alors uniquement quand
 * on franchit un seuil (3 fois au total sur toute la plage), pas à chaque
 * pixel de zoom. La compensation dynamique de font-size a été retirée : les
 * niveaux < full sont des cartes colorées silencieuses.
 */
const levelSelector = (s: {
	transform: readonly [number, number, number];
}): ZoomLevel => levelForZoom(s.transform[2]);

export function TableNode({ data }: NodeProps<TableNodeType>) {
	const { collection, dimmed, focused, matched } = data;
	const level = useStore(levelSelector);
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

	// ── LOD < full : cartes colorées silencieuses (dot / pill / compact) ────
	// Les trois niveaux rendent le même HTML — seul le zoom RF les distingue
	// visuellement (dot ≈ point coloré, compact ≈ carrelage). Le tooltip
	// Mantine (portal → coord écran, taille constante) affiche le nom au
	// survol : friendly, à la demande, aucun bruit au repos.
	if (level !== "full") {
		return (
			<Tooltip
				label={collection.name}
				openDelay={150}
				withArrow
				position="top"
				color="dark"
			>
				<div style={{ ...shellStyle, background: color.border }}>
					<Handle
						type="target"
						position={Position.Left}
						style={HIDDEN_HANDLE}
					/>
					<Handle
						type="source"
						position={Position.Right}
						style={HIDDEN_HANDLE}
					/>
				</div>
			</Tooltip>
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
