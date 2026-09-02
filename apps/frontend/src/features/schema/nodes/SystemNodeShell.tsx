import { IconLock } from "@tabler/icons-react";
import { Handle, NodeResizer, Position } from "@xyflow/react";
import { type CSSProperties, Fragment } from "react";

/** Palette système — distincte des tables user (bleu declared / ambre
 * inferred). Violet indigo = famille « meta / infrastructure ». Source
 * unique pour TOUS les nodes système (schema_events, enums, …). */
export const SYSTEM_BORDER = "#7c5cff";
export const SYSTEM_HEADER = "rgba(124,92,255,0.12)";

const HIDDEN_HANDLE: CSSProperties = { opacity: 0, border: "none" };
const HANDLE_SIDES = [
	{ id: "top", position: Position.Top },
	{ id: "right", position: Position.Right },
	{ id: "bottom", position: Position.Bottom },
	{ id: "left", position: Position.Left }
] as const;

/** 4 sides × source+target invisibles — permet aux edges RF d'ancrer sur
 * n'importe quel côté sans afficher de poignées. Partagé par tous les
 * nodes système (extrait de SystemSchemaEventsNode, qui le dupliquait
 * de TableNode). */
export function AllHandles() {
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

export interface SystemNodeShellProps {
	readonly width: number;
	readonly height: number;
	readonly minWidth: number;
	readonly minHeight: number;
	/** Icône du header (14px, teintée SYSTEM_BORDER par le caller). */
	readonly icon: React.ReactNode;
	readonly title: string;
	/** Contenu additionnel à droite du header, AVANT le badge SYSTÈME
	 * (ex : count). */
	readonly headerRight?: React.ReactNode;
	readonly onResizeEnd?: (params: {
		width: number;
		height: number;
		x: number;
		y: number;
	}) => void;
	readonly children: React.ReactNode;
}

/**
 * Chrome partagé des nodes système RF : bordure violette, header (icône +
 * titre + badge « Système » IconLock), NodeResizer stylé + AllHandles.
 * Extrait de SystemSchemaEventsNode quand le node Enums est arrivé — un
 * 2ᵉ consommateur = composant partagé, pas une copie ([[feedback-reuse-
 * rf-node-pattern]]). Le body est un slot : chaque node système garde
 * uniquement son contenu propre.
 */
export function SystemNodeShell({
	width,
	height,
	minWidth,
	minHeight,
	icon,
	title,
	headerRight,
	onResizeEnd,
	children
}: SystemNodeShellProps) {
	return (
		<div
			style={{
				width,
				height,
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
				minWidth={minWidth}
				maxWidth={800}
				minHeight={minHeight}
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
					flexShrink: 0
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
					{icon}
					{title}
				</span>
				<span
					style={{
						display: "flex",
						alignItems: "center",
						gap: 6
					}}
				>
					{headerRight}
					<span
						style={{
							display: "flex",
							alignItems: "center",
							gap: 3,
							fontSize: 10,
							fontWeight: 600,
							color: SYSTEM_BORDER,
							letterSpacing: 0.5,
							textTransform: "uppercase"
						}}
					>
						<IconLock size={10} stroke={2.5} />
						Système
					</span>
				</span>
			</div>
			{children}
		</div>
	);
}
