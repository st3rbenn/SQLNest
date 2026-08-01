import { Box, UnstyledButton } from "@mantine/core";
import {
	HintPill,
	SearchInput,
	SidebarDrawer,
	spotlight,
	useModKeyLabel
} from "@sqlnest/design-system";
import { IconChevronLeft } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FrameDetails } from "../FrameDetails";
import type { Frame } from "../frames";
import { SchemaTree } from "../SchemaTree";
import type { SchemaModel } from "../schema-model";
import { TableDetails } from "../table-details";
import type { useFrames } from "../useFrames";

const DRAWER_MIN_WIDTH = 260;
const DRAWER_MAX_WIDTH = 600;
const DRAWER_DEFAULT_WIDTH = 320;
const DRAWER_STORAGE_KEY = "sqlnest:leftDrawer:width";

interface ResizableDrawerHandleProps {
	readonly onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
	readonly onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
	readonly onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
	readonly onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
}

/**
 * State + handlers du drawer gauche resizable. Persiste la largeur en
 * localStorage. Clampé entre MIN/MAX. Immune au batching React 18 grâce à
 * un ref sur l'origine du geste (le state `width` peut lagger derrière
 * plusieurs `pointermove` — le delta absolu depuis l'origine reste correct).
 */
export function useResizableDrawer(): {
	readonly width: number;
	readonly handleProps: ResizableDrawerHandleProps;
} {
	const [width, setWidth] = useState<number>(() => {
		if (typeof window === "undefined") return DRAWER_DEFAULT_WIDTH;
		const raw = window.localStorage.getItem(DRAWER_STORAGE_KEY);
		const parsed = raw !== null ? Number.parseInt(raw, 10) : Number.NaN;
		if (!Number.isFinite(parsed)) return DRAWER_DEFAULT_WIDTH;
		return Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, parsed));
	});
	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			window.localStorage.setItem(DRAWER_STORAGE_KEY, String(width));
		} catch {
			/* quota / private mode — no-op */
		}
	}, [width]);

	const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
	const onPointerDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			e.currentTarget.setPointerCapture(e.pointerId);
			dragRef.current = { startX: e.clientX, startWidth: width };
			e.preventDefault();
		},
		[width]
	);
	const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		const state = dragRef.current;
		if (!state) return;
		const next = Math.min(
			DRAWER_MAX_WIDTH,
			Math.max(DRAWER_MIN_WIDTH, state.startWidth + (e.clientX - state.startX))
		);
		setWidth(next);
	}, []);
	const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		e.currentTarget.releasePointerCapture(e.pointerId);
		dragRef.current = null;
	}, []);

	return {
		width,
		handleProps: {
			onPointerDown,
			onPointerMove,
			onPointerUp,
			onPointerCancel: onPointerUp
		}
	};
}

interface DrawerPaneProps {
	readonly schema: SchemaModel;
	readonly width: number;
	readonly handleProps: ResizableDrawerHandleProps;
	readonly search: string;
	readonly onSearchChange: (value: string) => void;
	readonly framesApi: ReturnType<typeof useFrames>;
	readonly focusId: string | null;
	readonly focusFrameKey: string | null;
	readonly focusedFrame: Frame | undefined;
	readonly onClearFocus: () => void;
	readonly onClearFocusFrame: () => void;
	readonly onFocusTable: (name: string) => void;
	/** Rename/delete d'un frame depuis FrameDetails. Passés depuis SchemaCanvas
	 * pour partager le même handler que le badge du frame (inclut la
	 * notification + le checkpoint d'historique). */
	readonly onFrameRename?: (key: string, label: string) => void;
	readonly onFrameDelete?: (key: string) => void;
}

/**
 * Drawer gauche unifié — routing entre SchemaTree (défaut), TableDetails
 * (focusId) et FrameDetails (focusFrameKey). Header switch entre SearchInput
 * et back button, footer expose la palette Cmd+K, handle draggable à droite.
 * Rend `null` si `width` est 0 (parent gère la visibilité).
 */
export function DrawerPane({
	schema,
	width,
	handleProps,
	search,
	onSearchChange,
	framesApi,
	focusId,
	focusFrameKey,
	focusedFrame,
	onClearFocus,
	onClearFocusFrame,
	onFocusTable,
	onFrameRename,
	onFrameDelete
}: DrawerPaneProps) {
	const modKey = useModKeyLabel();
	const isDetailsView = focusId !== null || focusFrameKey !== null;

	return (
		<Box
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				bottom: 0,
				width,
				zIndex: 4
			}}
		>
			<SidebarDrawer
				variant="docked"
				width={width}
				{...(isDetailsView ? {} : { title: "Schéma" })}
				header={
					isDetailsView ? (
						<UnstyledButton
							onClick={onClearFocus}
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 4,
								fontSize: 12.5,
								color: "var(--sqlnest-text-secondary)",
								fontWeight: 500
							}}
							aria-label="Retour au schéma"
						>
							<IconChevronLeft size={14} stroke={2} />
							<span>Schéma</span>
						</UnstyledButton>
					) : (
						<SearchInput
							value={search}
							onChange={(e) => onSearchChange(e.currentTarget.value)}
							placeholder={`Rechercher parmi ${schema.collections.length} tables…`}
						/>
					)
				}
				footer={
					<UnstyledButton
						onClick={() => spotlight.open()}
						aria-label="Ouvrir la palette de commandes"
						style={{ width: "100%" }}
					>
						<HintPill
							keys={[`${modKey}K`]}
							bg="transparent"
							withBorder={false}
							shadow="none"
							style={{ display: "flex", justifyContent: "center" }}
						>
							Actions rapides
						</HintPill>
					</UnstyledButton>
				}
				style={{ height: "100%" }}
			>
				{focusFrameKey !== null && focusedFrame !== undefined ? (
					<FrameDetails
						frame={focusedFrame}
						onSelectTable={onFocusTable}
						onRename={(label) => {
							if (onFrameRename) onFrameRename(focusedFrame.key, label);
							else framesApi.renameFrame(focusedFrame.key, label);
						}}
						onDelete={() => {
							if (onFrameDelete) onFrameDelete(focusedFrame.key);
							else framesApi.removeFrame(focusedFrame.key);
							onClearFocusFrame();
						}}
					/>
				) : focusId !== null ? (
					<TableDetails
						schema={schema}
						tableName={focusId}
						frameLabel={framesApi.frameOfTable(focusId)?.label ?? null}
						onSelect={onFocusTable}
					/>
				) : (
					<SchemaTree
						schema={schema}
						frames={framesApi.frames}
						focusId={focusId}
						search={search}
						onSelect={onFocusTable}
					/>
				)}
			</SidebarDrawer>
			{/* Handle draggable — barre verticale fine sur le bord droit.
			 * Overlay au-dessus du chevron du drawer content. `touchAction:none`
			 * évite les gestes tactiles concurrents (scroll page). */}
			<Box
				{...handleProps}
				role="separator"
				aria-orientation="vertical"
				aria-label="Redimensionner le drawer"
				style={{
					position: "absolute",
					top: 0,
					bottom: 0,
					right: -3,
					width: 6,
					cursor: "col-resize",
					touchAction: "none",
					zIndex: 6
				}}
			/>
		</Box>
	);
}
