/**
 * Toolbar de la vue Canvas : dropdown de tri à gauche + toggle grid/list
 * à droite. Placement discret, aligné à droite au-dessus de la grille.
 *
 * Design aligné sur le reste de l'app :
 *  - Le dropdown de tri utilise Mantine `Menu` custom-styled (mêmes
 *    tokens `--sqlnest-*` que `UserMenu`) — surface, border-subtle,
 *    fontSize 12, active state cohérent.
 *  - Le toggle vue reuse `ToolbarButton` du design-system (variant
 *    `light` sur l'actif) — identique au CanvasToolbar du canvas view.
 *
 * Choix persistés dans localStorage via `useLocalStorage`
 * (@mantine/hooks) — clés `sqlnest.gallery.sort` / `.view`
 * device-scoped, rien côté backend.
 */

import { ToolbarButton } from "@sqlnest/design-system";
import { Menu } from "@mantine/core";
import {
	IconCheck,
	IconChevronDown,
	IconLayoutGrid,
	IconList
} from "@tabler/icons-react";
import type { CSSProperties } from "react";

export type CanvasSortKey =
	| "name-asc"
	| "name-desc"
	| "paired-desc"
	| "last-used-desc"
	| "created-desc";

export type CanvasViewMode = "grid" | "list";

const SORT_OPTIONS: {
	readonly value: CanvasSortKey;
	readonly label: string;
}[] = [
	{ value: "name-asc", label: "Nom (A→Z)" },
	{ value: "name-desc", label: "Nom (Z→A)" },
	{ value: "paired-desc", label: "Récemment pairé" },
	{ value: "last-used-desc", label: "Dernière activité" },
	{ value: "created-desc", label: "Récemment créé" }
];

const containerStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "flex-end",
	gap: 8
};

// Trigger du dropdown — reprend le style « outlined » du NewCanvasCta
// (surface + border, fontSize 12/500) pour cohérence visuelle avec les
// autres CTA du header. Chevron minimal à droite.
const triggerStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	padding: "5px 8px 5px 12px",
	background: "var(--sqlnest-surface)",
	color: "var(--sqlnest-text-primary)",
	border: "1px solid var(--sqlnest-border)",
	borderRadius: 6,
	fontSize: 12,
	fontWeight: 500,
	cursor: "pointer",
	boxSizing: "border-box",
	whiteSpace: "nowrap",
	minHeight: 30
};

const triggerLabelStyle: CSSProperties = {
	color: "var(--sqlnest-text-secondary)",
	fontWeight: 400
};

export function GalleryToolbar({
	sort,
	view,
	onSortChange,
	onViewChange
}: {
	readonly sort: CanvasSortKey;
	readonly view: CanvasViewMode;
	readonly onSortChange: (next: CanvasSortKey) => void;
	readonly onViewChange: (next: CanvasViewMode) => void;
}): React.ReactNode {
	const activeLabel =
		SORT_OPTIONS.find((o) => o.value === sort)?.label ?? "Nom (A→Z)";

	return (
		<div style={containerStyle}>
			<Menu
				shadow="md"
				width={200}
				position="bottom-end"
				withArrow={false}
				offset={6}
				radius={8}
				styles={{
					dropdown: {
						background: "var(--sqlnest-surface)",
						border: "1px solid var(--sqlnest-border-subtle)",
						padding: 3
					},
					item: {
						fontSize: 12,
						color: "var(--sqlnest-text-primary)",
						padding: "5px 8px",
						borderRadius: 5,
						minHeight: 0
					}
				}}
			>
				<Menu.Target>
					<button
						type="button"
						style={triggerStyle}
						className="sqlnest-header-cta"
						aria-label="Trier par"
					>
						<span style={triggerLabelStyle}>Trier :</span>
						<span>{activeLabel}</span>
						<IconChevronDown
							size={13}
							stroke={2}
							aria-hidden
							style={{ opacity: 0.6 }}
						/>
					</button>
				</Menu.Target>

				<Menu.Dropdown>
					{SORT_OPTIONS.map((opt) => {
						const isActive = opt.value === sort;
						return (
							<Menu.Item
								key={opt.value}
								onClick={() => onSortChange(opt.value)}
								rightSection={
									isActive ? (
										<IconCheck
											size={12}
											stroke={2.5}
											color="var(--sqlnest-accent)"
										/>
									) : null
								}
								style={
									isActive
										? {
												color: "var(--sqlnest-text-primary)",
												fontWeight: 600
											}
										: undefined
								}
							>
								{opt.label}
							</Menu.Item>
						);
					})}
				</Menu.Dropdown>
			</Menu>

			{/* Toggle grid/list — 2 ToolbarButton côte-à-côte, variant
			    light sur l'actif (même pattern que CanvasToolbar). */}
			<div style={{ display: "inline-flex", gap: 2 }}>
				<ToolbarButton
					label="Vue grille"
					active={view === "grid"}
					size={30}
					onClick={() => onViewChange("grid")}
				>
					<IconLayoutGrid size={15} stroke={2} />
				</ToolbarButton>
				<ToolbarButton
					label="Vue liste"
					active={view === "list"}
					size={30}
					onClick={() => onViewChange("list")}
				>
					<IconList size={15} stroke={2} />
				</ToolbarButton>
			</div>
		</div>
	);
}
