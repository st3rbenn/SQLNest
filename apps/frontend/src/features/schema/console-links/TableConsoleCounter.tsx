import { Menu } from "@mantine/core";
import {
	getBezierPath,
	Position,
	useNestCanvas,
	useNestStore,
	useViewport
} from "@sqlnest/canvas";
import { IconCheck, IconPlus, IconTerminal2 } from "@tabler/icons-react";
import {
	type CSSProperties,
	useContext,
	useEffect,
	useRef,
	useState
} from "react";
import { createPortal } from "react-dom";
import { ConsoleLinksContext, type FlowPoint } from "./ConsoleLinksContext";

const counterStyle = (active: boolean): CSSProperties => ({
	display: "inline-flex",
	alignItems: "center",
	gap: 3,
	padding: "1px 5px",
	border: 0,
	borderRadius: "var(--sqlnest-radius-4)",
	background: active ? "var(--sqlnest-accent)" : "var(--sqlnest-surface-hover)",
	color: "var(--sqlnest-text-primary)",
	fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
	fontSize: "var(--sqlnest-font-size-10)",
	fontWeight: 700,
	lineHeight: "15.5px",
	letterSpacing: 0.3,
	cursor: "pointer"
});

/** Forme réduite, sur une table devenue un bloc : un rond, le nombre seul. */
const denseStyle = (active: boolean): CSSProperties => ({
	...counterStyle(active),
	justifyContent: "center",
	minWidth: 16,
	height: 16,
	padding: "0 4px",
	borderRadius: "var(--sqlnest-radius-8)",
	lineHeight: "16px"
});

const menuClassNames = { item: "sqlnest-menu-item" } as const;

function rows(count: number): string {
	return `${count} ligne${count > 1 ? "s" : ""}`;
}

/** Le compteur n'est pas la table : ni sélection, ni focus, ni drag. */
const quiet = {
	onMouseDown: (e: React.SyntheticEvent) => e.stopPropagation(),
	onDoubleClick: (e: React.SyntheticEvent) => e.stopPropagation()
};

/** Déplacement à partir duquel un appui devient un glisser. */
const DRAG_THRESHOLD = 6;

interface ScreenPoint {
	readonly x: number;
	readonly y: number;
}

/** Milieu du côté de `rect` qui fait face à `to`, et ce côté. */
function facingSide(
	rect: DOMRect,
	to: ScreenPoint
): { readonly from: ScreenPoint; readonly side: Position } {
	const cx = rect.left + rect.width / 2;
	const cy = rect.top + rect.height / 2;
	const dx = to.x - cx;
	const dy = to.y - cy;
	if (Math.abs(dx) * rect.height >= Math.abs(dy) * rect.width) {
		return dx >= 0
			? { from: { x: rect.right, y: cy }, side: Position.Right }
			: { from: { x: rect.left, y: cy }, side: Position.Left };
	}
	return dy >= 0
		? { from: { x: cx, y: rect.bottom }, side: Position.Bottom }
		: { from: { x: cx, y: rect.top }, side: Position.Top };
}

const OPPOSITE: Record<Position, Position> = {
	[Position.Left]: Position.Right,
	[Position.Right]: Position.Left,
	[Position.Top]: Position.Bottom,
	[Position.Bottom]: Position.Top
};

/**
 * Glisser depuis le bouton de la table pour poser une console ailleurs :
 * le lien pointillé qui reliera la console à sa table se tend déjà de la
 * table au pointeur, `onDrop` reçoit le point du canvas où il est lâché. Un
 * simple clic reste un clic ; `wasDragged` permet au bouton d'ignorer celui
 * qui suit un glisser.
 */
function useDragOut(onDrop: (at: FlowPoint) => void): {
	readonly onPointerDown: (e: React.PointerEvent) => void;
	readonly wasDragged: () => boolean;
	readonly ghost: React.ReactNode;
} {
	const { screenToFlowPosition } = useNestCanvas();
	const [pointer, setPointer] = useState<ScreenPoint | null>(null);
	const dragged = useRef(false);
	const origin = useRef<DOMRect | null>(null);
	const dropRef = useRef(onDrop);
	dropRef.current = onDrop;

	function onPointerDown(e: React.PointerEvent): void {
		e.stopPropagation();
		if (e.button !== 0) return;
		const start = { x: e.clientX, y: e.clientY };
		// Le lien part de la table, pas du bouton.
		const table = e.currentTarget.closest(".nest-node") ?? e.currentTarget;
		origin.current = table.getBoundingClientRect();
		dragged.current = false;
		function onMove(ev: PointerEvent): void {
			const far =
				Math.hypot(ev.clientX - start.x, ev.clientY - start.y) >=
				DRAG_THRESHOLD;
			if (!dragged.current && !far) return;
			dragged.current = true;
			setPointer({ x: ev.clientX, y: ev.clientY });
		}
		function onUp(ev: PointerEvent): void {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			setPointer(null);
			if (dragged.current) {
				dropRef.current(screenToFlowPosition({ x: ev.clientX, y: ev.clientY }));
			}
		}
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	let ghost: React.ReactNode = null;
	if (pointer !== null && origin.current !== null) {
		const { from, side } = facingSide(origin.current, pointer);
		const [path] = getBezierPath({
			sourceX: from.x,
			sourceY: from.y,
			sourcePosition: side,
			targetX: pointer.x,
			targetY: pointer.y,
			targetPosition: OPPOSITE[side]
		});
		ghost = createPortal(
			<svg
				aria-hidden="true"
				style={{
					position: "fixed",
					inset: 0,
					width: "100vw",
					height: "100vh",
					pointerEvents: "none",
					zIndex: 2000
				}}
			>
				<path
					d={path}
					fill="none"
					stroke="var(--sqlnest-accent)"
					strokeWidth={1.5}
					strokeDasharray="6 5"
				/>
				<circle
					cx={pointer.x}
					cy={pointer.y}
					r={4}
					fill="var(--sqlnest-accent)"
				/>
			</svg>,
			document.body
		);
	}
	return { onPointerDown, wasDragged: () => dragged.current, ghost };
}

/**
 * Consoles d'une table, dans son en-tête. Avec des consoles : leur compteur,
 * dont le clic ouvre la liste. Sans : un bouton qui n'apparaît qu'au survol
 * de la table, pour en ouvrir une première.
 */
export function TableConsoleCounter({
	table,
	dense = false
}: {
	readonly table: string;
	/** Rond sans icône, pour une table réduite à un bloc. */
	readonly dense?: boolean;
}): React.ReactNode {
	const links = useContext(ConsoleLinksContext);
	const entries = links?.byTable.get(table) ?? [];
	const foldedEntries = entries.filter((e) => !links?.openIds.has(e.id));
	const folded = foldedEntries.length;
	const [menuOpen, setMenuOpen] = useState(false);
	// Lâcher le bouton ailleurs pose une console à cet endroit : la première
	// repliée de la table, sinon une nouvelle.
	const drag = useDragOut((at) => {
		const first = foldedEntries[0];
		if (first !== undefined) links?.open(first.id, at);
		else links?.createFor(table, at);
	});

	// Une console qui se replie rejoint ce compteur : il le signale.
	const [flash, setFlash] = useState(false);
	const previous = useRef(folded);
	useEffect(() => {
		if (folded > previous.current) setFlash(true);
		previous.current = folded;
	}, [folded]);

	if (links === null) return null;
	if (entries.length === 0) {
		return (
			<>
				<button
					type="button"
					className="nodrag nopan sqlnest-console-add"
					style={counterStyle(false)}
					aria-label="Nouvelle console"
					{...quiet}
					onPointerDown={drag.onPointerDown}
					onClick={(e) => {
						e.stopPropagation();
						// Le clic qui clôt un glisser a déjà posé sa console.
						if (!drag.wasDragged()) links.createFor(table);
					}}
				>
					<IconTerminal2 size={11} stroke={2.2} aria-hidden />
					<IconPlus size={9} stroke={3} aria-hidden />
				</button>
				{drag.ghost}
			</>
		);
	}
	const active = entries.some((e) => links.openIds.has(e.id));
	return (
		<Menu
			shadow="md"
			width={260}
			position="bottom-start"
			offset={6}
			radius="var(--sqlnest-radius-8)"
			classNames={menuClassNames}
			opened={menuOpen}
			// Un glisser depuis le compteur n'ouvre pas la liste.
			onChange={(next) => setMenuOpen(next && !drag.wasDragged())}
		>
			<Menu.Target>
				<button
					type="button"
					className={
						flash ? "nodrag nopan sqlnest-console-flash" : "nodrag nopan"
					}
					style={dense ? denseStyle(active) : counterStyle(active)}
					aria-label={`${entries.length} console${entries.length > 1 ? "s" : ""}`}
					{...quiet}
					onPointerDown={drag.onPointerDown}
					onClick={(e) => e.stopPropagation()}
					onAnimationEnd={() => setFlash(false)}
				>
					{dense ? null : <IconTerminal2 size={11} stroke={2.2} aria-hidden />}
					{entries.length}
				</button>
			</Menu.Target>
			{/* Le menu vit dans un portail, mais ses clics remontent l'arbre
			    React jusqu'à la table : sans cet arrêt, choisir une console
			    sélectionnerait et focaliserait la table. */}
			<Menu.Dropdown
				onClick={(e) => e.stopPropagation()}
				onDoubleClick={(e) => e.stopPropagation()}
			>
				{entries.map((entry) => {
					const isOpen = links.openIds.has(entry.id);
					const Icon = isOpen ? IconCheck : IconTerminal2;
					return (
						<Menu.Item
							key={entry.id}
							leftSection={<Icon size={14} stroke={2} aria-hidden />}
							rightSection={
								entry.lastResult !== undefined ? (
									<span style={{ whiteSpace: "nowrap" }}>
										{rows(entry.lastResult.rowCount)}
									</span>
								) : undefined
							}
							// Une console dépliée se replie par la même entrée.
							onClick={() =>
								isOpen ? links.fold(entry.id) : links.open(entry.id, "beside")
							}
						>
							<span
								style={{
									display: "block",
									maxWidth: 150,
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap"
								}}
							>
								{entry.title}
							</span>
						</Menu.Item>
					);
				})}
				<Menu.Divider />
				<Menu.Item
					leftSection={<IconPlus size={14} stroke={2} aria-hidden />}
					onClick={() => links.createFor(table)}
				>
					Nouvelle console
				</Menu.Item>
			</Menu.Dropdown>
			{drag.ghost}
		</Menu>
	);
}

/** Zoom sous lequel le compteur de l'en-tête ne se lit plus : la pastille
 * à taille constante prend le relais. */
const BADGE_BELOW_ZOOM = 0.5;
/** Zoom sous lequel le rond d'un bloc cesse de compenser le zoom : plus
 * loin, il rétrécit avec le canvas au lieu de recouvrir les tables. */
const DENSE_FLOOR_ZOOM = 0.2;

const zoomedOut = (s: { readonly transform: readonly number[] }): boolean =>
	(s.transform[2] ?? 1) < BADGE_BELOW_ZOOM;

/** Compteur d'en-tête, masqué tant que la pastille de zoom arrière le remplace. */
function HeaderCounter({ table }: { readonly table: string }): React.ReactNode {
	// Un booléen : la table ne se redessine qu'au passage du seuil.
	const replaced = useNestStore(zoomedOut);
	return replaced ? null : <TableConsoleCounter table={table} />;
}

/**
 * Consoles d'une table dans son en-tête. Sous le seuil de zoom, une table
 * qui a des consoles les montre par sa pastille de coin (`TableConsoleBadge`)
 * et non ici : un seul compteur à la fois.
 */
export function TableHeaderConsoles({
	table
}: {
	readonly table: string;
}): React.ReactNode {
	const links = useContext(ConsoleLinksContext);
	const count = links?.byTable.get(table)?.length ?? 0;
	return count === 0 ? (
		<TableConsoleCounter table={table} />
	) : (
		<HeaderCounter table={table} />
	);
}

/** Compteur à taille d'écran constante, quel que soit le zoom du canvas. */
function ScaledCounter({
	table,
	onlyZoomedOut,
	dense
}: {
	readonly table: string;
	readonly onlyZoomedOut: boolean;
	readonly dense: boolean;
}): React.ReactNode {
	const { zoom } = useViewport();
	if (onlyZoomedOut && zoom >= BADGE_BELOW_ZOOM) return null;
	const scale = 1 / (dense ? Math.max(zoom, DENSE_FLOOR_ZOOM) : zoom);
	return (
		<div
			style={{
				position: "absolute",
				top: 6,
				right: 6,
				transform: `scale(${scale})`,
				transformOrigin: "top right"
			}}
		>
			<TableConsoleCounter table={table} dense={dense} />
		</div>
	);
}

/**
 * Compteur de consoles posé dans le coin d'une table en zoom arrière. Avec
 * `onlyZoomedOut`, sur une table détaillée dès que le zoom passe sous le
 * seuil : pastille à taille d'écran constante. Avec `dense`, sur une table
 * réduite à un bloc : un petit rond, qui ne grossit pas indéfiniment face
 * aux blocs. Une table sans console n'affiche rien.
 */
export function TableConsoleBadge({
	table,
	onlyZoomedOut = false,
	dense = false
}: {
	readonly table: string;
	readonly onlyZoomedOut?: boolean;
	readonly dense?: boolean;
}): React.ReactNode {
	const links = useContext(ConsoleLinksContext);
	const count = links?.byTable.get(table)?.length ?? 0;
	return count === 0 ? null : (
		<ScaledCounter table={table} onlyZoomedOut={onlyZoomedOut} dense={dense} />
	);
}
