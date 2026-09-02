import { IconBraces, IconChevronDown, IconChevronRight, IconPlus } from "@tabler/icons-react";
import type { Node, NodeProps } from "@xyflow/react";
import { useState } from "react";
import {
	SYSTEM_BORDER,
	SystemNodeShell
} from "../schema/nodes/SystemNodeShell";

export const ENUMS_NODE_ID = "__sqlnest_enums__";
export const ENUMS_NODE_DEFAULT_WIDTH = 260;
export const ENUMS_NODE_DEFAULT_HEIGHT = 190;
export const ENUMS_NODE_MIN_WIDTH = 220;
export const ENUMS_NODE_MIN_HEIGHT = 120;

/** Vue minimale d'un enum pour le node — dérivée de `SchemaModel.enums`. */
export interface EnumNodeEntry {
	readonly name: string;
	readonly members: readonly string[];
}

export interface SystemEnumsNodeData {
	readonly enums: readonly EnumNodeEntry[];
	/** Ouvre une console pré-remplie `add enum member <name> ""` — le pont
	 * lecture → édition sans taper le nom (ni sa casse) à la main. */
	readonly onAddMember?: (enumName: string) => void;
	readonly onResizeEnd?: (params: {
		width: number;
		height: number;
		x: number;
		y: number;
	}) => void;
	readonly [key: string]: unknown;
}

export type SystemEnumsNodeType = Node<SystemEnumsNodeData, "system-enums">;

/**
 * Node RF système « Enums » (sprint EN) — rend `schema.enums` visible sur le
 * canvas : un enum n'est pas une table, il était invisible et son nom exact
 * (casse comprise, ex. DISASTER_QUALIFICATION) indevinable sans `raw`.
 * Injecté seulement quand le schéma déclare ≥1 enum, non-supprimable,
 * draggable + resizable.
 *
 * Le chrome (bordure violette, header + badge Système, NodeResizer,
 * AllHandles) vit dans [[SystemNodeShell]] — partagé avec schema_events.
 * Ici : uniquement les rows d'enums expandables + l'action « + membre ».
 */
export function SystemEnumsNode({
	data,
	width,
	height: heightProp
}: NodeProps<SystemEnumsNodeType>) {
	const { enums, onAddMember, onResizeEnd } = data;
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

	const toggle = (name: string): void => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	};

	return (
		<div style={{ position: "relative" }}>
			<SystemNodeShell
				width={width ?? ENUMS_NODE_DEFAULT_WIDTH}
				height={heightProp ?? ENUMS_NODE_DEFAULT_HEIGHT}
				minWidth={ENUMS_NODE_MIN_WIDTH}
				minHeight={ENUMS_NODE_MIN_HEIGHT}
				icon={<IconBraces size={14} stroke={2} color={SYSTEM_BORDER} />}
				title="Enums"
				onResizeEnd={onResizeEnd}
			>
				{/* Anatomie miroir schema_events : le body est du contenu TRONQUÉ
				  * par la hauteur (overflow hidden, resize pour voir plus) — PAS
				  * une zone scrollable. La frame se drag en l'attrapant partout
				  * SAUF sur les contrôles (chevron+nom, « + ») qui portent
				  * `nodrag` — sans lui le d3-drag RF capture le mousedown et le
				  * click ne fire pas (même raison que le footer schema_events).
				  * Les boutons sont réduits à leur contenu, le reste de chaque
				  * row est une zone draggable. */}
				<div
					style={{
						flex: "1 1 auto",
						minHeight: 0,
						overflow: "hidden",
						padding: "4px 0"
					}}
				>
					{enums.map((e) => (
						<EnumRow
							key={e.name}
							entry={e}
							expanded={expanded.has(e.name)}
							onToggle={() => toggle(e.name)}
							onAddMember={
								onAddMember !== undefined
									? () => onAddMember(e.name)
									: undefined
							}
						/>
					))}
				</div>
			</SystemNodeShell>
		</div>
	);
}

function EnumRow({
	entry,
	expanded,
	onToggle,
	onAddMember
}: {
	readonly entry: EnumNodeEntry;
	readonly expanded: boolean;
	readonly onToggle: () => void;
	readonly onAddMember?: () => void;
}) {
	return (
		<div>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 4,
					padding: "0 6px 0 8px",
					height: 24
				}}
			>
				<button
					type="button"
					className="nodrag"
					onClick={(ev) => {
						ev.stopPropagation();
						onToggle();
					}}
					style={{
						display: "flex",
						alignItems: "center",
						gap: 5,
						flex: "0 1 auto",
						minWidth: 0,
						background: "transparent",
						border: "none",
						padding: "0 2px",
						color: "var(--sqlnest-text-secondary)",
						fontSize: 11.5,
						cursor: "pointer",
						textAlign: "left"
					}}
				>
					{expanded ? (
						<IconChevronDown size={11} stroke={2} />
					) : (
						<IconChevronRight size={11} stroke={2} />
					)}
					<span
						style={{
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							fontFamily: "ui-monospace, monospace",
							color: "var(--sqlnest-text-primary)"
						}}
					>
						{entry.name}
					</span>
				</button>
				{/* Spacer draggable — la zone entre le nom et le count attrape
				  * le drag de la frame (aucun nodrag ici). */}
				<span style={{ flex: "1 1 auto" }} />
				<span
					style={{
						flexShrink: 0,
						fontSize: 10.5,
						color: "var(--sqlnest-text-tertiary)"
					}}
				>
					{entry.members.length}
				</span>
				{onAddMember !== undefined && (
					<button
						type="button"
						className="nodrag"
						title={`add enum member ${entry.name}`}
						onClick={(ev) => {
							ev.stopPropagation();
							onAddMember();
						}}
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							width: 18,
							height: 18,
							flexShrink: 0,
							background: "transparent",
							border: "1px solid var(--sqlnest-border-subtle)",
							borderRadius: 4,
							color: "var(--sqlnest-text-tertiary)",
							cursor: "pointer"
						}}
					>
						<IconPlus size={11} stroke={2} />
					</button>
				)}
			</div>
			{expanded && (
				<div style={{ padding: "1px 0 4px" }}>
					{entry.members.map((m, i) => (
						<div
							key={m}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 8,
								padding: "1px 12px 1px 26px",
								fontSize: 10.5,
								fontFamily: "ui-monospace, monospace",
								color: "var(--sqlnest-text-secondary)"
							}}
						>
							<span
								style={{
									color: "var(--sqlnest-text-tertiary)",
									minWidth: 14,
									textAlign: "right"
								}}
							>
								{i + 1}
							</span>
							<span>{m}</span>
						</div>
					))}
					{entry.members.length === 0 && (
						<p
							style={{
								margin: 0,
								padding: "1px 12px 1px 26px",
								fontSize: 10.5,
								color: "var(--sqlnest-text-tertiary)"
							}}
						>
							Aucun membre
						</p>
					)}
				</div>
			)}
		</div>
	);
}
