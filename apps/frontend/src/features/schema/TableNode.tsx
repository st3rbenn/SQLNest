import { Tooltip } from "@mantine/core";
import { KindBadge, TypePill } from "@sqlnest/design-system";
import {
	Handle,
	type Node,
	type NodeProps,
	NodeResizer,
	Position,
	useStore
} from "@xyflow/react";
import { type CSSProperties, Fragment } from "react";
import { colorFor } from "./colors";
import type { Side } from "./edgeRouting";
import type { Collection } from "./schema-model";
import { levelForZoom, type ZoomLevel } from "./zoomLevel";

/** Nombre de champs affichés dans la hauteur par défaut (avant que l'user
 * ne resize verticalement). Passé cette limite, la carte affiche `+N champs…`
 * qui devient cliquable → l'user tire le handle bas pour révéler plus. */
export const MAX_FIELDS = 12;
export const NODE_WIDTH = 240;
const HEADER_H = 44;
const ROW_H = 20;
/** Padding vertical dans le body (`padding: "4px 0"` = 8 px total). */
const BODY_PAD = 8;

/** Hauteur d'un nœud table, dérivée du nombre de champs (stable → layout stable).
 * Sert de valeur par défaut au mount ELK — user peut resize après (voir
 * `visibleFieldCount`). */
export function nodeHeight(collection: Collection): number {
	const shown = Math.min(collection.fields.length, MAX_FIELDS);
	const more = collection.fields.length > MAX_FIELDS ? ROW_H : 0;
	return HEADER_H + shown * ROW_H + more + BODY_PAD;
}

/**
 * Combien de fields peuvent tenir dans une hauteur donnée. Pure → testable.
 * - Si tous les fields rentrent : `shown = total`, `hidden = 0` (pas de « +N »).
 * - Sinon : `shown = maxRows - 1` (une ligne réservée à `+N champs…`),
 *   `hidden = total - shown`.
 * L'utilisateur voit exactement ce qu'il a la place de voir — le nombre
 * s'adapte au resize vertical.
 */
export function visibleFieldCount(
	availableHeight: number,
	totalFields: number
): { shown: number; hidden: number } {
	const available = availableHeight - HEADER_H - BODY_PAD;
	const maxRows = Math.max(0, Math.floor(available / ROW_H));
	if (maxRows >= totalFields) return { shown: totalFields, hidden: 0 };
	const shown = Math.max(0, maxRows - 1);
	return { shown, hidden: totalFields - shown };
}

export interface TableNodeData {
	readonly collection: Collection;
	/** Estompé (hors focus / hors recherche). */
	readonly dimmed: boolean;
	/** Nœud focalisé (cliqué). */
	readonly focused: boolean;
	/** Correspond à la recherche courante. */
	readonly matched: boolean;
	/** Callback au release du resize (n'importe quel côté ou coin). Fourni par
	 * SchemaCanvas → persist localStorage via `useTableSizes` (dimensions) et
	 * `useTablePositions` (origine, quand elle a bougé depuis un handle
	 * gauche/haut). Absent = table non resizable (rendu externe / test). */
	readonly onResizeEnd?: (size: {
		width: number;
		height: number;
		x: number;
		y: number;
	}) => void;
	readonly [key: string]: unknown;
}

export type TableNodeType = Node<TableNodeData, "table">;

const HIDDEN_HANDLE: CSSProperties = { opacity: 0, border: "none" };

/**
 * 4 côtés × (source + target) = 8 handles par table. Les edges pointent
 * chacun sur une paire précise via `sourceHandle`/`targetHandle` (calculée
 * dans `SchemaCanvas.displayEdges` selon les positions relatives). Sans ces
 * 4 côtés, RF n'aurait que Left/Right et les tables empilées verticalement
 * verraient leurs arrows partir dans le vide.
 */
const HANDLE_SIDES: readonly { id: Side; position: Position }[] = [
	{ id: "top", position: Position.Top },
	{ id: "right", position: Position.Right },
	{ id: "bottom", position: Position.Bottom },
	{ id: "left", position: Position.Left }
];

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
 * Sélecteur Zustand : niveau LOD dérivé du zoom courant. On ne remonte QUE
 * le niveau (pas le zoom brut) — la node se re-render alors uniquement quand
 * on franchit un seuil (3 fois au total sur toute la plage), pas à chaque
 * pixel de zoom. La compensation dynamique de font-size a été retirée : les
 * niveaux < full sont des cartes colorées silencieuses.
 */
const levelSelector = (s: {
	transform: readonly [number, number, number];
}): ZoomLevel => levelForZoom(s.transform[2]);

export function TableNode({
	data,
	selected,
	width,
	height: heightProp
}: NodeProps<TableNodeType>) {
	const { collection, dimmed, focused, matched, onResizeEnd } = data;
	const level = useStore(levelSelector);
	const inferred = collection.source === "inferred";
	const color = colorFor(collection.name);
	const contentHeight = nodeHeight(collection);
	// Dimensions effectives — RF push les valeurs du store (mises à jour en
	// direct pendant un drag de resize) ; défauts pour le tout premier render.
	const effectiveWidth = width ?? NODE_WIDTH;
	const effectiveHeight = heightProp ?? contentHeight;

	// Un SEUL indicateur visuel de mise en avant. `focused` (data.focused —
	// click simple pilote le drawer détails) et `selected` (RF store — geste
	// multi via Cmd/Shift/lasso) reçoivent le même traitement : border
	// interne bleu vif + shadow diffuse bleu. Sans ça, les deux stacks CSS
	// se cumulaient (contour interne + outline exterieur `.selected`) et
	// donnaient des styles mixtes selon comment la table était mise en avant.
	const highlighted = focused || selected;

	// Enveloppe commune : shell surface Figma, border colorée par hue
	// (accent bleu / warning jaune override en focus / match), shadow noir
	// diffuse, gestion `dimmed`. LOD variants remplissent l'enveloppe à la
	// taille RÉELLE — sinon les handles (aux bords du wrapper RF) ne
	// s'alignent plus avec le visuel à faible zoom.
	const shellStyle: CSSProperties = {
		width: effectiveWidth,
		height: effectiveHeight,
		borderRadius: 10,
		background: "var(--sqlnest-surface)",
		border: `2px solid ${matched ? "#ffc933" : highlighted ? "#0d99ff" : color.border}`,
		boxShadow: highlighted
			? "0 0 0 3px rgba(13,153,255,0.35), 0 8px 24px rgba(0,0,0,0.45)"
			: matched
				? "0 0 0 3px rgba(255,201,51,0.4)"
				: "0 1px 3px rgba(0,0,0,0.35)",
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
					<AllHandles />
				</div>
			</Tooltip>
		);
	}

	// ── LOD level 1 : full (zoom ≥ FULL_MIN) ──────────────────────────
	const pk = new Set(collection.primaryKey ?? []);
	// Combien de fields tiennent dans la hauteur COURANTE (adaptatif au resize
	// vertical). Sur une table à peine ouverte : cap à MAX_FIELDS. User agrandit
	// → révèle plus. User rétrécit → cache et compte dans « +N champs… ».
	const { shown: shownCount, hidden } = visibleFieldCount(
		effectiveHeight,
		collection.fields.length
	);
	const shown = collection.fields.slice(0, shownCount);
	return (
		<div style={shellStyle}>
			<AllHandles />
			{/* NodeResizer complet : 4 sides + 4 corners. Handles invisibles
			 * par défaut (opacité 0 via `.react-flow__node-table` override CSS
			 * dans canvas-overrides.css), apparaissent au hover du node — évite
			 * la pollution visuelle quand plein de tables sont à l'écran. La
			 * bordure line reste visible pour signaler la cible du drag. */}
			{onResizeEnd !== undefined ? (
				<NodeResizer
					isVisible
					minWidth={200}
					maxWidth={800}
					minHeight={60}
					maxHeight={1600}
					onResizeEnd={(_, p) =>
						onResizeEnd({
							width: p.width,
							height: p.height,
							x: p.x,
							y: p.y
						})
					}
					lineStyle={{
						borderColor: color.border,
						borderWidth: 1.5
					}}
					handleStyle={{
						width: 8,
						height: 8,
						borderRadius: 2,
						background: "var(--sqlnest-surface)",
						borderColor: color.border,
						borderWidth: 2
					}}
				/>
			) : null}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 8,
					padding: "10px 12px",
					borderBottom: "1px solid var(--sqlnest-border)",
					background: color.header
				}}
			>
				<span
					style={{
						fontWeight: 700,
						fontSize: 13,
						color: "var(--sqlnest-text-primary)",
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
								color: "var(--sqlnest-text-secondary)",
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
							color: "var(--sqlnest-text-tertiary)",
							display: "flex",
							alignItems: "center"
						}}
					>
						+{hidden} champ{hidden > 1 ? "s" : ""}…
					</div>
				) : null}
			</div>
		</div>
	);
}
