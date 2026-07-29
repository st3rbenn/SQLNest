import type { CSSProperties } from "react";
import { colorFor } from "./colors";
import type { SchemaModel } from "./schema-model";

interface TableDetailsProps {
	readonly schema: SchemaModel;
	readonly tableName: string;
	readonly onSelect: (id: string) => void;
	readonly onClose: () => void;
}

const drawerStyle: CSSProperties = {
	position: "absolute",
	top: 12,
	left: 12,
	bottom: 12,
	width: 340,
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

const closeButton: CSSProperties = {
	border: "none",
	background: "transparent",
	color: "#64748b",
	cursor: "pointer",
	fontSize: 18,
	padding: 4,
	borderRadius: 6,
	lineHeight: 1
};

const sectionTitle: CSSProperties = {
	fontSize: 10.5,
	fontWeight: 700,
	letterSpacing: 0.5,
	color: "#94a3b8",
	textTransform: "uppercase",
	padding: "12px 14px 6px"
};

const fieldRow: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: 8,
	padding: "5px 14px",
	fontSize: 12.5,
	color: "#334155"
};

const fkLink: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	width: "100%",
	padding: "8px 14px",
	fontSize: 12.5,
	cursor: "pointer",
	background: "#fff",
	border: "none",
	borderLeft: "3px solid transparent",
	color: "#334155",
	textAlign: "left",
	fontFamily: "inherit"
};

/**
 * Drawer gauche — infos de la table focus, avec relations **cliquables** :
 * chaque FK est un lien vers l'autre table du canvas (« walk to » : centre la
 * vue + change le focus). Remplace avantageusement une modal dédiée : le canvas
 * reste visible en fond, la navigation est fluide entre tables voisines.
 */
export function TableDetails({
	schema,
	tableName,
	onSelect,
	onClose
}: TableDetailsProps) {
	const table = schema.collections.find((c) => c.name === tableName);
	if (table === undefined) return null;

	const inferred = table.source === "inferred";
	const color = colorFor(table.name);
	const pk = new Set(table.primaryKey ?? []);
	const outgoing = schema.relations.filter(
		(r) => r.from.collection === tableName
	);
	const incoming = schema.relations.filter(
		(r) => r.to.collection === tableName
	);

	return (
		<div style={drawerStyle}>
			<div
				style={{
					padding: "14px 14px 12px",
					borderBottom: `2px solid ${color.border}`,
					background: color.header
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 8
					}}
				>
					<span style={{ fontWeight: 700, fontSize: 15, color: color.text }}>
						{table.name}
					</span>
					<button
						type="button"
						onClick={onClose}
						style={closeButton}
						aria-label="Fermer le panneau"
					>
						×
					</button>
				</div>
				<div
					style={{
						marginTop: 6,
						fontSize: 11,
						color: color.text,
						opacity: 0.75
					}}
				>
					{table.fields.length} champ(s) · {outgoing.length + incoming.length}{" "}
					relation(s) · {inferred ? "schéma inféré" : "schéma déclaré"}
				</div>
			</div>

			<div style={{ flex: 1, overflowY: "auto" }}>
				<div style={sectionTitle}>Champs</div>
				{table.fields.map((f) => {
					const isPk = pk.has(f.name);
					const conf =
						f.confidence !== undefined ? Math.round(f.confidence * 100) : null;
					return (
						<div key={f.name} style={fieldRow}>
							<span
								style={{
									display: "flex",
									alignItems: "center",
									gap: 6,
									minWidth: 0,
									overflow: "hidden"
								}}
							>
								{isPk ? (
									<span
										style={{
											fontSize: 8,
											fontWeight: 700,
											color: "#b45309",
											background: "#fef3c7",
											padding: "1px 4px",
											borderRadius: 3
										}}
									>
										PK
									</span>
								) : null}
								<span
									style={{
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap"
									}}
								>
									{f.name}
								</span>
							</span>
							<span
								style={{
									color: "#94a3b8",
									fontFamily: "ui-monospace, SFMono-Regular, monospace",
									fontSize: 11,
									whiteSpace: "nowrap"
								}}
							>
								{f.type}
								{f.nullable ? " ?" : ""}
								{conf !== null && conf < 100 ? ` · ${conf}%` : ""}
							</span>
						</div>
					);
				})}

				{outgoing.length > 0 ? (
					<>
						<div style={sectionTitle}>→ Références (FK sortantes)</div>
						{outgoing.map((r, i) => (
							<RelationLink
								// biome-ignore lint/suspicious/noArrayIndexKey: relation identity is (from,to,fields) — index suffices here
								key={`out-${i}`}
								label={`${r.from.fields.join(",")} → ${r.to.collection}.${r.to.fields.join(",")}`}
								target={r.to.collection}
								inferred={r.origin !== "foreign-key"}
								onSelect={onSelect}
							/>
						))}
					</>
				) : null}

				{incoming.length > 0 ? (
					<>
						<div style={sectionTitle}>← Référencée par (FK entrantes)</div>
						{incoming.map((r, i) => (
							<RelationLink
								// biome-ignore lint/suspicious/noArrayIndexKey: relation identity is (from,to,fields) — index suffices here
								key={`in-${i}`}
								label={`${r.from.collection}.${r.from.fields.join(",")} → ${r.to.fields.join(",")}`}
								target={r.from.collection}
								inferred={r.origin !== "foreign-key"}
								onSelect={onSelect}
							/>
						))}
					</>
				) : null}

				{outgoing.length + incoming.length === 0 ? (
					<div
						style={{
							padding: "12px 14px",
							fontSize: 12,
							color: "#94a3b8",
							fontStyle: "italic"
						}}
					>
						Aucune relation connue.
					</div>
				) : null}
			</div>
		</div>
	);
}

function RelationLink({
	label,
	target,
	inferred,
	onSelect
}: {
	readonly label: string;
	readonly target: string;
	readonly inferred: boolean;
	readonly onSelect: (id: string) => void;
}) {
	const color = colorFor(target);
	return (
		<button
			type="button"
			style={fkLink}
			onClick={() => onSelect(target)}
			title={`Aller à ${target}`}
		>
			<span
				style={{
					display: "inline-block",
					width: 10,
					height: 10,
					borderRadius: 3,
					background: color.border,
					flexShrink: 0
				}}
			/>
			<span
				style={{
					flex: 1,
					fontFamily: "ui-monospace, SFMono-Regular, monospace",
					fontSize: 11,
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap"
				}}
			>
				{label}
			</span>
			{inferred ? (
				<span
					style={{
						fontSize: 9,
						color: "#b45309",
						background: "#fef3c7",
						padding: "1px 4px",
						borderRadius: 3
					}}
				>
					INF
				</span>
			) : null}
		</button>
	);
}
