import {
	IconBraces,
	IconChevronDown,
	IconChevronRight,
	IconPlus
} from "@tabler/icons-react";
import {
	Handle,
	type Node,
	type NodeProps,
	NodeResizer,
	Position
} from "@xyflow/react";
import { type CSSProperties, Fragment, useState } from "react";

export const ENUMS_NODE_ID = "__sqlnest_enums__";
export const ENUMS_NODE_DEFAULT_WIDTH = 260;
export const ENUMS_NODE_DEFAULT_HEIGHT = 190;
export const ENUMS_NODE_MIN_WIDTH = 220;
export const ENUMS_NODE_MIN_HEIGHT = 120;

const HEADER_H = 46;

/** Palette système partagée avec SystemSchemaEventsNode — violet indigo =
 * famille « meta / infrastructure », distincte des tables user. */
const SYSTEM_BORDER = "#7c5cff";
const SYSTEM_HEADER = "rgba(124,92,255,0.12)";

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

const HIDDEN_HANDLE: CSSProperties = { opacity: 0, border: "none" };
const HANDLE_SIDES = [
	{ id: "top", position: Position.Top },
	{ id: "right", position: Position.Right },
	{ id: "bottom", position: Position.Bottom },
	{ id: "left", position: Position.Left }
] as const;

function AllHandles() {
	return (
		<>
			{HANDLE_SIDES.map((s) => (
				<Fragment key={s.id}>
					<Handle
						id={s.id}
						type="source"
						position={s.position}
						style={HIDDEN_HANDLE}
					/>
					<Handle
						id={s.id}
						type="target"
						position={s.position}
						style={HIDDEN_HANDLE}
					/>
				</Fragment>
			))}
		</>
	);
}

/**
 * Node RF système « Enums » (sprint EN) — rend `schema.enums` visible sur le
 * canvas : un enum n'est pas une table, il était invisible et son nom exact
 * (casse comprise, ex. DISASTER_QUALIFICATION) indevinable sans `raw`.
 * Injecté seulement quand le schéma déclare ≥1 enum, non-supprimable,
 * draggable + resizable.
 *
 * Réutilise le pattern SystemSchemaEventsNode : `NodeResizer` + `AllHandles`
 * + géométrie persistée via `useEnumsNode`. Chaque enum est une row
 * expandable in-place (membres ordonnés) avec une action « + membre » qui
 * ouvre une console pré-remplie.
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

	const effectiveWidth = width ?? ENUMS_NODE_DEFAULT_WIDTH;
	const effectiveHeight = heightProp ?? ENUMS_NODE_DEFAULT_HEIGHT;

	return (
		<div style={{ position: "relative" }}>
			<div
				style={{
					width: effectiveWidth,
					height: effectiveHeight,
					background: "var(--sqlnest-surface)",
					border: `2px solid ${SYSTEM_BORDER}`,
					borderRadius: 10,
					overflow: "hidden",
					fontFamily: "ui-sans-serif, system-ui, sans-serif",
					boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
					display: "flex",
					flexDirection: "column"
				}}
			>
				<NodeResizer
					isVisible
					minWidth={ENUMS_NODE_MIN_WIDTH}
					maxWidth={800}
					minHeight={ENUMS_NODE_MIN_HEIGHT}
					maxHeight={1200}
					lineStyle={{ borderColor: SYSTEM_BORDER, borderWidth: 1.5 }}
					handleStyle={{
						width: 8,
						height: 8,
						borderRadius: 2,
						background: "var(--sqlnest-surface)",
						borderColor: SYSTEM_BORDER,
						borderWidth: 2
					}}
					onResizeEnd={(_, params) =>
						onResizeEnd?.({
							width: params.width,
							height: params.height,
							x: params.x ?? 0,
							y: params.y ?? 0
						})
					}
				/>
				<AllHandles />
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 8,
						padding: "10px 12px",
						borderBottom: "1px solid var(--sqlnest-border)",
						background: SYSTEM_HEADER,
						flexShrink: 0,
						height: HEADER_H,
						boxSizing: "border-box"
					}}
				>
					<span
						style={{
							display: "flex",
							alignItems: "center",
							gap: 6,
							fontWeight: 700,
							fontSize: 13,
							color: "var(--sqlnest-text-primary)"
						}}
					>
						<IconBraces size={14} stroke={2} color={SYSTEM_BORDER} />
						Enums
					</span>
					<span
						style={{
							fontSize: 10,
							fontWeight: 600,
							color: SYSTEM_BORDER,
							letterSpacing: 0.5,
							textTransform: "uppercase"
						}}
					>
						{enums.length}
					</span>
				</div>
				<div
					className="nowheel nodrag"
					style={{
						flex: "1 1 auto",
						minHeight: 0,
						overflowY: "auto",
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
			</div>
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
						flex: "1 1 auto",
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
					<span
						style={{
							marginLeft: "auto",
							flexShrink: 0,
							fontSize: 10.5,
							color: "var(--sqlnest-text-tertiary)"
						}}
					>
						{entry.members.length}
					</span>
				</button>
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
