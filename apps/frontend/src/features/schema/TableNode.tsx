import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import type { CSSProperties } from "react";
import { colorFor } from "./colors";
import type { Collection } from "./schema-model";

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

const badgeStyle = (inferred: boolean): CSSProperties => ({
	fontSize: 9,
	fontWeight: 700,
	letterSpacing: 0.3,
	padding: "2px 6px",
	borderRadius: 5,
	background: inferred ? "#fef3c7" : "#dbeafe",
	color: inferred ? "#b45309" : "#1d4ed8"
});

const HIDDEN_HANDLE: CSSProperties = { opacity: 0, border: "none" };

export function TableNode({ data }: NodeProps<TableNodeType>) {
	const { collection, dimmed, focused, matched } = data;
	const inferred = collection.source === "inferred";
	const pk = new Set(collection.primaryKey ?? []);
	const shown = collection.fields.slice(0, MAX_FIELDS);
	const hidden = collection.fields.length - shown.length;
	// Couleur stable dérivée du nom : distingue les groupes visuellement (les
	// préfixes contribuent le plus au hash, donc `xref_p*` sont teintes proches).
	const color = colorFor(collection.name);

	return (
		<div
			style={{
				width: NODE_WIDTH,
				borderRadius: 10,
				background: "#fff",
				// La border reprend la teinte de la table ; focus/match la surchargent
				// avec les couleurs de sélection (bleu/ambre) pour rester lisibles.
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
			}}
		>
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
				<span style={badgeStyle(inferred)}>
					{inferred ? "INFÉRÉ" : "DÉCLARÉ"}
				</span>
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
							{pk.has(f.name) ? (
								<span
									style={{
										fontSize: 8,
										fontWeight: 700,
										color: "#b45309",
										background: "#fef3c7",
										padding: "1px 3px",
										borderRadius: 3
									}}
								>
									PK
								</span>
							) : null}
							{f.name}
						</span>
						<span
							style={{
								color: "#94a3b8",
								fontFamily: "ui-monospace, SFMono-Regular, monospace",
								fontSize: 10.5,
								whiteSpace: "nowrap"
							}}
						>
							{f.type}
							{f.nullable ? " ?" : ""}
						</span>
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
