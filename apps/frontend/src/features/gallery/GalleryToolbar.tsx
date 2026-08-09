/**
 * Toolbar de la vue Canvas : dropdown de tri à gauche + segmented control
 * grid/list à droite. Placement discret, aligné à droite au-dessus de la
 * grille. Choix persistés dans localStorage via `useLocalStorage`
 * (@mantine/hooks) — la clé `sqlnest.gallery.sort` / `.view` reste
 * device-scoped (rien côté backend).
 */

import { SegmentedControl, Select } from "@mantine/core";
import { IconLayoutGrid, IconList } from "@tabler/icons-react";
import type { CSSProperties } from "react";

export type CanvasSortKey =
	| "name-asc"
	| "name-desc"
	| "paired-desc"
	| "last-used-desc"
	| "created-desc";

export type CanvasViewMode = "grid" | "list";

const SORT_OPTIONS: { readonly value: CanvasSortKey; readonly label: string }[] =
	[
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
	gap: 10
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
	return (
		<div style={containerStyle}>
			<Select
				value={sort}
				onChange={(v) => {
					if (v) onSortChange(v as CanvasSortKey);
				}}
				data={SORT_OPTIONS as unknown as { value: string; label: string }[]}
				size="xs"
				allowDeselect={false}
				checkIconPosition="right"
				w={180}
				comboboxProps={{ width: 220, position: "bottom-end" }}
				styles={{
					input: {
						background: "var(--sqlnest-surface)",
						borderColor: "var(--sqlnest-border)",
						color: "var(--sqlnest-text-primary)",
						fontSize: 12,
						fontWeight: 500
					}
				}}
				aria-label="Trier par"
			/>

			<SegmentedControl
				value={view}
				onChange={(v) => onViewChange(v as CanvasViewMode)}
				size="xs"
				data={[
					{
						value: "grid",
						label: (
							<IconLayoutGrid
								size={14}
								stroke={2}
								aria-label="Vue grille"
							/>
						)
					},
					{
						value: "list",
						label: <IconList size={14} stroke={2} aria-label="Vue liste" />
					}
				]}
				styles={{
					root: {
						background: "var(--sqlnest-surface)",
						border: "1px solid var(--sqlnest-border)"
					}
				}}
			/>
		</div>
	);
}
