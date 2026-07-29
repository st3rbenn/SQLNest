import { type CSSProperties, useMemo, useState } from "react";
import { colorFor } from "./colors";
import type { SchemaModel } from "./schema-model";

interface SchemaTreeProps {
	readonly schema: SchemaModel;
	readonly focusId: string | null;
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

const drawerStyle: CSSProperties = {
	position: "absolute",
	top: 12,
	right: 12,
	bottom: 12,
	width: 300,
	background: "#fff",
	border: "1px solid #e2e8f0",
	borderRadius: 12,
	boxShadow: "0 8px 24px rgba(15,23,42,0.10)",
	display: "flex",
	flexDirection: "column",
	overflow: "hidden",
	fontFamily: "ui-sans-serif, system-ui, sans-serif",
	zIndex: 4
};

const searchStyle: CSSProperties = {
	padding: "8px 10px",
	borderRadius: 8,
	border: "1px solid #e2e8f0",
	fontSize: 13,
	width: "100%",
	boxSizing: "border-box",
	outline: "none"
};

const headerRow: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	width: "100%",
	padding: "6px 8px",
	background: "#f8fafc",
	cursor: "pointer",
	userSelect: "none",
	fontSize: 12,
	color: "#334155",
	fontWeight: 600,
	border: "none",
	borderTop: "1px solid #f1f5f9",
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
 * Drawer droit — arborescence de la base + recherche fusionnée. Clic sur une
 * table = « walk to » (l'appelant centre la vue et applique le focus). Regroupe
 * automatiquement les tables par préfixe : sur RNAcentral, les 68 partitions
 * `xref_p*` deviennent un seul groupe pliable, ce qui rend une base de 186
 * tables navigable comme un arbre de projet.
 */
export function SchemaTree({ schema, focusId, onSelect }: SchemaTreeProps) {
	const [search, setSearch] = useState("");
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
		<div style={drawerStyle}>
			<div
				style={{
					padding: 12,
					borderBottom: "1px solid #f1f5f9",
					display: "flex",
					flexDirection: "column",
					gap: 8
				}}
			>
				<input
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder={`Rechercher parmi ${schema.collections.length} tables…`}
					spellCheck={false}
					style={searchStyle}
				/>
				<div style={{ fontSize: 11, color: "#94a3b8" }}>
					{query === "" ? (
						<>
							{schema.collections.length} tables · {schema.relations.length}{" "}
							relations
						</>
					) : (
						<>{totalMatch} résultat(s)</>
					)}
				</div>
			</div>
			<div style={{ flex: 1, overflowY: "auto" }}>
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
									<span style={{ color: "#cbd5e1", marginRight: 6 }}>
										{showChildren ? "▾" : "▸"}
									</span>
									{g.name}
								</span>
								<span style={{ color: "#94a3b8", fontWeight: 500 }}>
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
													background: isFocus ? "#eff6ff" : "#fff",
													borderLeftColor: isFocus ? "#2563eb" : "transparent",
													color: isFocus ? "#1d4ed8" : "#334155",
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
			</div>
		</div>
	);
}
