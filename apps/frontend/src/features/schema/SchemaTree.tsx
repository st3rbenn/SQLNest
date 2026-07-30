import { Box, Text } from "@mantine/core";
import { type CSSProperties, useMemo, useState } from "react";
import { colorFor } from "./colors";
import type { SchemaModel } from "./schema-model";

interface SchemaTreeProps {
	readonly schema: SchemaModel;
	readonly focusId: string | null;
	readonly search: string;
	readonly onSelect: (id: string) => void;
}

const PARTITIONED = /^([a-z][a-z0-9]*)_p\d+/;

/**
 * Extrait un préfixe de groupe raisonnable :
 *  - `xref_p12_deleted` → `xref` (partitions numérotées)
 *  - `rnc_sequence_features` → `rnc`
 *  - `orders`, `users` → segment complet (pas de groupe, juste racines)
 * Une table isolée sans préfixe distinct devient sa propre entrée racine.
 */
function groupOf(name: string): string {
	const partitioned = PARTITIONED.exec(name);
	if (partitioned?.[1] !== undefined) return partitioned[1];
	const first = name.split("_")[0];
	return first ?? name;
}

interface Group {
	readonly name: string;
	readonly tables: string[];
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
 * Arborescence des tables + regroupement automatique par préfixe. Rendue à
 * l'intérieur d'un `SidebarDrawer` par le parent : la recherche vit à part
 * (slot `header` du drawer), ce composant reçoit sa valeur en prop.
 */
export function SchemaTree({
	schema,
	focusId,
	search,
	onSelect
}: SchemaTreeProps) {
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
		() => new Set()
	);

	const groups = useMemo<Group[]>(() => {
		const byGroup = new Map<string, string[]>();
		for (const c of schema.collections) {
			const g = groupOf(c.name);
			const arr = byGroup.get(g) ?? [];
			arr.push(c.name);
			byGroup.set(g, arr);
		}
		return [...byGroup.entries()]
			.map(([name, tables]) => ({ name, tables: tables.slice().sort() }))
			.sort(
				(a, b) =>
					b.tables.length - a.tables.length || a.name.localeCompare(b.name)
			);
	}, [schema]);

	const query = search.trim().toLowerCase();
	// Filtrage : une table matche par son nom OU son groupe (« xref » matche
	// tous les `xref_p*`). Recherche non vide → tous les groupes contenant un
	// match sont dépliés automatiquement.
	const filtered = useMemo<Group[]>(() => {
		if (query === "") return groups;
		return groups
			.map((g) => ({
				name: g.name,
				tables: g.tables.filter(
					(t) => t.toLowerCase().includes(query) || g.name.includes(query)
				)
			}))
			.filter((g) => g.tables.length > 0);
	}, [groups, query]);

	const isCollapsed = (g: string) => query === "" && collapsed.has(g);

	const toggle = (g: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(g)) next.delete(g);
			else next.add(g);
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
				const showChildren = !isCollapsed(g.name);
				return (
					<div key={g.name}>
						<button
							type="button"
							style={headerRow}
							onClick={() => toggle(g.name)}
						>
							<span>
								<span
									style={{
										color: "var(--mantine-color-slate-3)",
										marginRight: 6
									}}
								>
									{showChildren ? "▾" : "▸"}
								</span>
								{g.name}
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
