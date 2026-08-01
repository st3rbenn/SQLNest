import { Box, Text, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { RowItem } from "@sqlnest/design-system";
import { type CSSProperties, useMemo, useState } from "react";
import { colorFor } from "./colors";
import type { Frame } from "./frames";
import type { Collection, SchemaModel } from "./schema-model";

interface SchemaTreeProps {
	readonly schema: SchemaModel;
	readonly frames: readonly Frame[];
	readonly focusId: string | null;
	readonly search: string;
	readonly onSelect: (id: string) => void;
}

const PARTITIONED = /^([a-z][a-z0-9]*)_p\d+/;

/**
 * Préfixe raisonnable :
 *  - `xref_p12_deleted` → `xref` (partitions numérotées)
 *  - `rnc_sequence_features` → `rnc`
 *  - `orders`, `users` → segment complet (racines isolées)
 */
function prefixOf(name: string): string {
	const partitioned = PARTITIONED.exec(name);
	if (partitioned?.[1] !== undefined) return partitioned[1];
	const first = name.split("_")[0];
	return first ?? name;
}

export interface TreeGroup {
	readonly key: string;
	readonly label: string;
	readonly kind: "frame" | "prefix";
	readonly hue?: number;
	readonly tables: readonly string[];
}

/**
 * Groupage pour l'arbre : frames explicites d'abord (dans leur ordre déclaré),
 * puis groupes de préfixe pour ce qui reste. Pure → testable sans DOM.
 */
export function buildTreeGroups(
	collections: readonly Collection[],
	frames: readonly Frame[]
): TreeGroup[] {
	const inFrame = new Map<string, string>();
	for (const f of frames) {
		for (const c of f.collections) {
			if (!inFrame.has(c)) inFrame.set(c, f.key);
		}
	}

	const collectionNames = new Set(collections.map((c) => c.name));
	const frameGroups: TreeGroup[] = frames
		.map<TreeGroup>((f) => ({
			key: `frame:${f.key}`,
			label: f.label,
			kind: "frame",
			hue: f.hue,
			tables: f.collections.filter((c) => collectionNames.has(c)).slice().sort()
		}))
		.filter((g) => g.tables.length > 0);

	const byPrefix = new Map<string, string[]>();
	for (const c of collections) {
		if (inFrame.has(c.name)) continue;
		const p = prefixOf(c.name);
		const arr = byPrefix.get(p) ?? [];
		arr.push(c.name);
		byPrefix.set(p, arr);
	}
	const prefixGroups: TreeGroup[] = [...byPrefix.entries()]
		.map<TreeGroup>(([name, tables]) => ({
			key: `prefix:${name}`,
			label: name,
			kind: "prefix",
			tables: tables.slice().sort()
		}))
		.sort(
			(a, b) =>
				b.tables.length - a.tables.length || a.label.localeCompare(b.label)
		);

	return [...frameGroups, ...prefixGroups];
}

const headerRow: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	width: "100%",
	padding: "7px 10px 7px 8px",
	background: "transparent",
	cursor: "pointer",
	userSelect: "none",
	fontSize: 12.5,
	color: "var(--sqlnest-text-primary)",
	fontWeight: 700,
	border: "none",
	textAlign: "left",
	fontFamily: "inherit",
	letterSpacing: 0.2
};

export function SchemaTree({
	schema,
	frames,
	focusId,
	search,
	onSelect
}: SchemaTreeProps) {
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
		() => new Set()
	);

	const groups = useMemo<TreeGroup[]>(
		() => buildTreeGroups(schema.collections, frames),
		[schema, frames]
	);

	const query = search.trim().toLowerCase();
	const filtered = useMemo<TreeGroup[]>(() => {
		if (query === "") return groups;
		return groups
			.map<TreeGroup>((g) => ({
				...g,
				tables: g.tables.filter(
					(t) =>
						t.toLowerCase().includes(query) ||
						g.label.toLowerCase().includes(query)
				)
			}))
			.filter((g) => g.tables.length > 0);
	}, [groups, query]);

	const isCollapsed = (k: string) => query === "" && collapsed.has(k);

	const toggle = (k: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(k)) next.delete(k);
			else next.add(k);
			return next;
		});
	};

	const totalMatch = filtered.reduce((s, g) => s + g.tables.length, 0);

	return (
		<Box>
			<Text px="sm" pt={6} pb={6} size="xs" c="dimmed">
				{query === ""
					? `${schema.collections.length} tables · ${schema.relations.length} relations`
					: `${totalMatch} résultat(s)`}
			</Text>
			{filtered.map((g) => {
				const showChildren = !isCollapsed(g.key);
				// Couleur du badge de groupe : hue explicite du frame si défini,
				// sinon dérive une couleur du label (hash stable → même préfixe
				// = même teinte à chaque render / reload).
				const groupColor =
					g.kind === "frame" && g.hue !== undefined
						? `hsl(${g.hue}, 55%, 60%)`
						: colorFor(g.label).border;
				return (
					<div key={g.key}>
						<UnstyledButton style={headerRow} onClick={() => toggle(g.key)}>
							<span
								style={{
									display: "inline-flex",
									alignItems: "center",
									gap: 8,
									minWidth: 0
								}}
							>
								<span
									style={{
										display: "inline-flex",
										color: "var(--sqlnest-text-tertiary)",
										lineHeight: 0
									}}
								>
									{showChildren ? (
										<IconChevronDown size={12} stroke={2.5} />
									) : (
										<IconChevronRight size={12} stroke={2.5} />
									)}
								</span>
								<span
									style={{
										display: "inline-block",
										width: 12,
										height: 12,
										borderRadius: 4,
										background: groupColor,
										flexShrink: 0
									}}
								/>
								<span
									style={{
										textTransform: g.kind === "frame" ? "uppercase" : "none",
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap"
									}}
								>
									{g.label}
								</span>
							</span>
							<span
								style={{
									color: "var(--sqlnest-text-tertiary)",
									fontWeight: 500,
									fontSize: 12
								}}
							>
								{g.tables.length}
							</span>
						</UnstyledButton>
						{showChildren
							? g.tables.map((t) => (
									<RowItem
										key={t}
										label={t}
										color={colorFor(t).border}
										active={t === focusId}
										onClick={() => onSelect(t)}
										title={t}
										paddingLeft={32}
									/>
								))
							: null}
					</div>
				);
			})}
		</Box>
	);
}
