import { ActionIcon, Box, Button, Menu, Text, UnstyledButton } from "@mantine/core";
import { IconChevronRight, IconDots, IconMenu2 } from "@tabler/icons-react";
import { KindBadge, showNotification } from "@sqlnest/design-system";
import { useNavigate } from "@tanstack/react-router";
import { colorFor } from "./colors";
import type { SchemaModel } from "./schema-model";

interface TableDetailsProps {
	readonly schema: SchemaModel;
	readonly tableName: string;
	readonly frameLabel: string | null;
	readonly onSelect: (id: string) => void;
}

/**
 * Vue « détails de table » — rendue **dans** le drawer gauche à la place de
 * l'arborescence quand une table est focus. Composant présentationnel : pas
 * de wrapper positionné, header, ni footer (fournis par `SidebarDrawer` du
 * parent). Le back button (« ← Schéma ») est géré côté `SchemaCanvas` — il
 * clear le focus, ce qui restaure l'arborescence dans le même drawer.
 */
export function TableDetails({
	schema,
	tableName,
	frameLabel,
	onSelect
}: TableDetailsProps) {
	const table = schema.collections.find((c) => c.name === tableName);
	const navigate = useNavigate();

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
	const totalRelations = outgoing.length + incoming.length;

	const soon = (title: string) =>
		showNotification({
			title,
			message: "Bientôt disponible.",
			color: "amber",
			autoClose: 2000
		});

	const goToEditor = () => {
		void navigate({
			to: "/query",
			search: { source: table.name, autorun: 1 }
		});
	};

	return (
		<Box>
			{/* Titre : dot coloré + name + KindBadge */}
			<Box style={{ padding: "10px 12px 2px" }}>
				<Box
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						minWidth: 0
					}}
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
							fontSize: 15,
							fontWeight: 700,
							color: "var(--mantine-color-slate-9)",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							minWidth: 0
						}}
						title={table.name}
					>
						{table.name}
					</span>
					<KindBadge kind={inferred ? "inferred" : "declared"} />
				</Box>
				<Text
					size="xs"
					c="dimmed"
					mt={2}
					style={{ fontSize: 10.5, letterSpacing: 0.1 }}
				>
					{table.fields.length} champs · {totalRelations} relations
					{frameLabel !== null ? (
						<>
							{" · frame "}
							<span
								style={{
									color: "var(--mantine-color-slate-7)",
									fontWeight: 600,
									textTransform: "uppercase"
								}}
							>
								{frameLabel}
							</span>
						</>
					) : null}
				</Text>
			</Box>

			{/* Actions : get X + hamburger + kebab */}
			<Box
				style={{
					display: "flex",
					alignItems: "center",
					gap: 6,
					padding: "8px 12px 6px"
				}}
			>
				<Button
					variant="filled"
					color="dark"
					radius="md"
					size="xs"
					onClick={goToEditor}
					style={{
						flex: 1,
						minWidth: 0,
						fontFamily: "var(--mantine-font-family-monospace)",
						overflow: "hidden"
					}}
					styles={{
						label: {
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap"
						}
					}}
					title={`get ${table.name}`}
				>
					{`>_ get ${table.name}`}
				</Button>
				<ActionIcon
					variant="default"
					size="md"
					radius="md"
					onClick={() => soon("Vue tabulaire")}
					aria-label="Vue tabulaire"
				>
					<IconMenu2 size={14} />
				</ActionIcon>
				<Menu shadow="md" position="bottom-end" withinPortal>
					<Menu.Target>
						<ActionIcon
							variant="default"
							size="md"
							radius="md"
							aria-label="Plus d'actions"
						>
							<IconDots size={14} />
						</ActionIcon>
					</Menu.Target>
					<Menu.Dropdown>
						<Menu.Item onClick={() => soon("Copier le nom")}>
							Copier le nom
						</Menu.Item>
						<Menu.Item onClick={() => soon("Exporter le schéma")}>
							Exporter le schéma
						</Menu.Item>
						<Menu.Item onClick={() => soon("Masquer la table")} color="red">
							Masquer la table
						</Menu.Item>
					</Menu.Dropdown>
				</Menu>
			</Box>

			{/* Section CHAMPS */}
			<SectionTitle>Champs</SectionTitle>
			{table.fields.map((f) => {
				const isPk = pk.has(f.name);
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

			{/* Section RÉFÉRENCES */}
			{outgoing.length > 0 ? (
				<>
					<SectionTitle prefix="→">Références</SectionTitle>
					{outgoing.map((r, i) => (
						<RelationLink
							// biome-ignore lint/suspicious/noArrayIndexKey: relation identity is (from,to,fields) — index suffices here
							key={`out-${i}`}
							label={`${r.from.fields.join(",")} → ${r.to.collection}.${r.to.fields.join(",")}`}
							target={r.to.collection}
							onSelect={onSelect}
						/>
					))}
				</>
			) : null}

			{incoming.length > 0 ? (
				<>
					<SectionTitle prefix="←">Référencée par</SectionTitle>
					{incoming.map((r, i) => (
						<RelationLink
							// biome-ignore lint/suspicious/noArrayIndexKey: relation identity is (from,to,fields) — index suffices here
							key={`in-${i}`}
							label={`${r.from.collection}.${r.from.fields.join(",")} → ${r.to.fields.join(",")}`}
							target={r.from.collection}
							onSelect={onSelect}
						/>
					))}
				</>
			) : null}

			{totalRelations === 0 ? (
				<Text px={12} py={8} size="xs" c="dimmed" fs="italic">
					Aucune relation connue.
				</Text>
			) : null}

			{/* Section SUGGESTION IA — placeholder ; brancher au moteur IA (tour futur). */}
			<SectionTitle>Suggestion IA</SectionTitle>
			<Box px={12} pb={12}>
				<UnstyledButton
					onClick={() => soon("Insérer la requête suggérée")}
					style={{
						display: "block",
						width: "100%",
						padding: 10,
						borderRadius: 8,
						background: "var(--mantine-color-brand-0)",
						border: "1px solid var(--mantine-color-brand-2)",
						textAlign: "left",
						cursor: "pointer",
						transition: "background 120ms ease-out"
					}}
				>
					<Text size="xs" fw={600} c="var(--mantine-color-brand-7)" mb={4}>
						+ Requête suggérée
					</Text>
					<Text
						size="xs"
						ff="var(--mantine-font-family-monospace)"
						c="var(--mantine-color-slate-8)"
						style={{ lineHeight: 1.5, fontSize: 10.5 }}
					>
						{`get ${table.name}${suggestPredicate(table)} | count`}
					</Text>
				</UnstyledButton>
			</Box>
		</Box>
	);
}

function SectionTitle({
	children,
	prefix
}: {
	readonly children: React.ReactNode;
	readonly prefix?: string;
}) {
	return (
		<Text
			px={12}
			pt={10}
			pb={4}
			size="xs"
			fw={700}
			c="dimmed"
			style={{ textTransform: "uppercase", letterSpacing: 0.5, fontSize: 9.5 }}
		>
			{prefix !== undefined ? `${prefix} ` : ""}
			{children}
		</Text>
	);
}

function RelationLink({
	label,
	target,
	onSelect
}: {
	readonly label: string;
	readonly target: string;
	readonly onSelect: (id: string) => void;
}) {
	const color = colorFor(target);
	return (
		<UnstyledButton
			onClick={() => onSelect(target)}
			title={`Aller à ${target}`}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				width: "100%",
				padding: "5px 12px",
				fontSize: 11,
				background: "#fff",
				textAlign: "left",
				transition: "background 100ms ease-out"
			}}
		>
			<span
				style={{
					display: "inline-block",
					width: 8,
					height: 8,
					borderRadius: "50%",
					background: color.border,
					flexShrink: 0
				}}
			/>
			<span
				style={{
					flex: 1,
					fontFamily: "var(--mantine-font-family-monospace)",
					fontSize: 10.5,
					color: "var(--mantine-color-slate-8)",
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap"
				}}
			>
				{label}
			</span>
			<IconChevronRight
				size={12}
				stroke={2}
				style={{ color: "var(--mantine-color-slate-4)", flexShrink: 0 }}
			/>
		</UnstyledButton>
	);
}

/**
 * Heuristique très simple pour la requête placeholder — utilise le 1er champ
 * bool trouvé comme prédicat. Sera remplacée par la vraie suggestion IA.
 */
function suggestPredicate(table: {
	fields: readonly { name: string; type: string }[];
}): string {
	const boolField = table.fields.find((f) => f.type === "bool");
	if (boolField !== undefined) return ` | where ${boolField.name} = true`;
	return "";
}
