import { Box } from "@mantine/core";
import { KindBadge } from "@sqlnest/design-system";
import type { Collection } from "../schema-model";
import { SectionTitle } from "./SectionTitle";

interface TableDetailsFieldsProps {
	readonly fields: Collection["fields"];
	readonly primaryKey: ReadonlySet<string>;
}

/**
 * Section CHAMPS du drawer TableDetails — liste toutes les colonnes avec
 * un badge PK, le type et l'indice de confiance (si < 100 %).
 */
export function TableDetailsFields({
	fields,
	primaryKey
}: TableDetailsFieldsProps) {
	return (
		<>
			<SectionTitle>Champs</SectionTitle>
			{fields.map((f) => {
				const isPk = primaryKey.has(f.name);
				const conf =
					f.confidence !== undefined ? Math.round(f.confidence * 100) : null;
				return (
					<Box
						key={f.name}
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 8,
							padding: "3px 12px",
							fontSize: 11.5,
							color: "var(--mantine-color-slate-8)"
						}}
					>
						<span
							style={{
								display: "flex",
								alignItems: "center",
								gap: 6,
								minWidth: 0,
								overflow: "hidden"
							}}
						>
							{isPk ? <KindBadge kind="pk" /> : null}
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
								color: "var(--mantine-color-slate-4)",
								fontFamily: "var(--mantine-font-family-monospace)",
								fontSize: 10.5,
								whiteSpace: "nowrap"
							}}
						>
							{f.type}
							{f.nullable ? " ?" : ""}
							{conf !== null && conf < 100 ? ` · ${conf}%` : ""}
						</span>
					</Box>
				);
			})}
		</>
	);
}
