import { Box, Text } from "@mantine/core";
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
	// 1. Index de couverture par les frames.
	const inFrame = new Map<string, string>(); // tableName → frameKey
	for (const f of frames) {
		for (const c of f.collections) {
			if (!inFrame.has(c)) inFrame.set(c, f.key);
		}
	}

	// 2. Groupes de frames : conservent l'ordre déclaré, filtrent les
	//    collections qui n'existent pas dans le schéma.
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

	// 3. Reste → groupes de préfixe (comme avant).
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
	padding: "6px 8px",
	background: "var(--mantine-color-slate-0)",
	cursor: "pointer",
	userSelect: "none",
	fontSize: 12,
	color: "var(--mantine-color-slate-7)",
	fontWeight: 600,
	border: "none",
	borderTop: "1px solid var(--mantine-color-slate-1)",
	textAlign: "left",
	fontFamily: "inherit"
};

const itemBase: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: 8,
	width: "100%",
	padding: "5px 10px 5px 22px",
	fontSize: 12.5,
	cursor: "pointer",
	borderLeft: "3px solid transparent",
	borderTop: "none",
	borderRight: "none",
	borderBottom: "none",
	textAlign: "left",
	fontFamily: "inherit"
};

/**
 * Arborescence des tables — frames explicites d'abord (avec leur pastille
 * colorée), puis groupes de préfixe pour ce qui reste. Rendue à l'intérieur
 * d'un `SidebarDrawer` par le parent.
 */
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
	// Filtrage : une table matche par son nom OU son groupe. Recherche non
	// vide → tous les groupes contenant un match sont dépliés automatiquement.
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
			<Text px="sm" pt={6} pb={4} size="xs" c="dimmed">
				{query === ""
					? `${schema.collections.length} tables · ${schema.relations.length} relations`
					: `${totalMatch} résultat(s)`}
			</Text>
			{filtered.map((g) => {
				const showChildren = !isCollapsed(g.key);
				return (
					<div key={g.key}>
						<button
							type="button"
							style={headerRow}
							onClick={() => toggle(g.key)}
						>
							<span
								style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
							>
								<span
									style={{
										color: "var(--mantine-color-slate-3)"
									}}
								>
									{showChildren ? "▾" : "▸"}
								</span>
								{g.kind === "frame" && g.hue !== undefined ? (
									<span
										style={{
											display: "inline-block",
											width: 10,
											height: 10,
											borderRadius: 3,
											background: `hsl(${g.hue}, 55%, 60%)`
										}}
									/>
								) : null}
								{g.label}
							</span>
							<span
								style={{
									color: "var(--mantine-color-slate-4)",
									fontWeight: 500
								}}
							>
								{g.tables.length}
							</span>
						</button>
						{showChildren
							? g.tables.map((t) => {
									const color = colorFor(t);
									const isFocus = t === focusId;
									return (
										<button
											key={t}
											type="button"
											style={{
												...itemBase,
												background: isFocus
													? "var(--mantine-color-brand-0)"
													: "#fff",
												borderLeftColor: isFocus
													? "var(--mantine-color-brand-6)"
													: "transparent",
												color: isFocus
													? "var(--mantine-color-brand-7)"
													: "var(--mantine-color-slate-7)",
												fontWeight: isFocus ? 600 : 400
											}}
											onClick={() => onSelect(t)}
											title={t}
										>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: 6,
													minWidth: 0
												}}
											>
												<span
													style={{
														display: "inline-block",
														width: 8,
														height: 8,
														borderRadius: 2,
														background: color.border,
														flexShrink: 0
													}}
												/>
												<span
													style={{
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap"
													}}
												>
													{t}
												</span>
											</span>
										</button>
									);
								})
							: null}
					</div>
				);
			})}
		</Box>
	);
}
