import {
	Box,
	Checkbox,
	Code,
	CopyButton,
	Group,
	NativeSelect,
	ScrollArea,
	Stack,
	Text,
	TextInput
} from "@mantine/core";
import { Button } from "@sqlnest/design-system";
import type { SchemaModel as SnqlSchemaModel } from "@sqlnest/snql";
import { useDebouncedValue } from "@mantine/hooks";
import {
	ORM_LABELS,
	type TunnelSchemaChangeNames,
	type TunnelSchemaCheck
} from "@sqlnest/tunnel-protocol";
import {
	IconAsterisk,
	IconCircleDashed,
	IconColumnInsertRight,
	IconColumnRemove,
	IconCursorText,
	IconEraser,
	IconLink,
	IconPencil,
	IconTransform,
	IconUnlink
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { matchesExpected } from "../../query/WriteConfirmBar";
import { useCanvasData, useCanvasUI } from "../canvas/CanvasContext";
import { CanvasSidePanel } from "../canvas/floating/CanvasSidePanel";
import type { Field } from "../schema-model";
import {
	applyChange,
	type ChangeOutcome,
	fetchChangeNames,
	typedNames
} from "./applyChange";
import { type ChangePreview, previewChange } from "./changePreview";
import {
	type AddRefGesture,
	addColumnSnql,
	addRefSnql,
	COLUMN_TYPES,
	type ChangeGesture,
	type ColumnGesture,
	dropColumnSnql,
	dropDefaultSnql,
	dropRefSnql,
	REF_RULES,
	type RefRule,
	renameColumnSnql,
	setDefaultSnql,
	setNullabilitySnql,
	setTypeSnql
} from "./changeSnql";
import { canApply, type EditMode } from "./editMode";
import { projectStatusQueryKey } from "./useProjectStatus";

const CHECK_LABELS: Readonly<Record<TunnelSchemaCheck["name"], string>> = {
	"model-database": "Modèle ↔ base",
	"history-model": "Historique ↔ modèle",
	structure: "Structure"
};

/** Nom de migration ou chemin, sans espace où aller à la ligne. */
const BREAK_ANYWHERE = { wordBreak: "break-all" } as const;

/** Exemple de défaut selon le type, en SNQL. */
const DEFAULT_PLACEHOLDERS: Readonly<Record<string, string>> = {
	string: '"…"',
	int: "0",
	bigint: "0",
	float: "0",
	decimal: "0",
	bool: "false",
	date: "now()",
	uuid: "uuid()"
};

const ICON = { size: 15, color: "var(--sqlnest-text-secondary)" } as const;

/** Une clé par ouverture : rouvrir le même geste repart d'un formulaire vide. */
const gestureKeys = new WeakMap<ChangeGesture, number>();
let lastGestureKey = 0;
function keyOf(gesture: ChangeGesture): number {
	let key = gestureKeys.get(gesture);
	if (key === undefined) {
		key = ++lastGestureKey;
		gestureKeys.set(gesture, key);
	}
	return key;
}

/**
 * Panneau d'un changement de schéma (ADR-039 D3 à D5) : formulaire du geste,
 * SNQL, DDL, avertissements, puis résultat de l'application.
 */
export function ChangePanel() {
	const { gesture, setGesture } = useCanvasUI();
	if (gesture === null) return null;
	const onClose = () => setGesture(null);
	const key = keyOf(gesture);
	switch (gesture.kind) {
		case "add-column":
			return (
				<AddColumnPanel key={key} table={gesture.table} onClose={onClose} />
			);
		case "add-ref":
			return <AddRefPanel key={key} gesture={gesture} onClose={onClose} />;
		case "drop-ref":
			return (
				<ChangeFrame
					key={key}
					icon={<IconUnlink {...ICON} />}
					title="Supprimer la relation"
					table={gesture.table}
					column={gesture.column}
					reference={`${gesture.targetTable}.${gesture.targetColumn}`}
					source={dropRefSnql(gesture.table, gesture.name)}
					onClose={onClose}
				/>
			);
		default:
			return <ColumnPanel key={key} gesture={gesture} onClose={onClose} />;
	}
}

function AddRefPanel({
	gesture,
	onClose
}: {
	readonly gesture: AddRefGesture;
	readonly onClose: () => void;
}) {
	const [onDelete, setOnDelete] = useState<RefRule>("restrict");
	const [onUpdate, setOnUpdate] = useState<RefRule>("restrict");
	return (
		<ChangeFrame
			icon={<IconLink {...ICON} />}
			title="Ajouter une relation"
			table={gesture.table}
			column={gesture.column}
			reference={`${gesture.targetTable}.${gesture.targetColumn}`}
			source={addRefSnql({ ...gesture, onDelete, onUpdate })}
			onClose={onClose}
		>
			{(locked) => (
				<>
					<NativeSelect
						size="xs"
						label="À la suppression"
						value={onDelete}
						onChange={(e) => setOnDelete(e.currentTarget.value as RefRule)}
						disabled={locked}
						data={[...REF_RULES]}
					/>
					<NativeSelect
						size="xs"
						label="À la mise à jour"
						value={onUpdate}
						onChange={(e) => setOnUpdate(e.currentTarget.value as RefRule)}
						disabled={locked}
						data={[...REF_RULES]}
					/>
				</>
			)}
		</ChangeFrame>
	);
}

function AddColumnPanel({
	table,
	onClose
}: {
	readonly table: string;
	readonly onClose: () => void;
}) {
	const [name, setName] = useState("");
	const [type, setType] = useState<string>("string");
	const [nullable, setNullable] = useState(true);
	const [defaultExpr, setDefaultExpr] = useState("");
	return (
		<ChangeFrame
			icon={<IconColumnInsertRight {...ICON} />}
			title="Ajouter une colonne"
			table={table}
			source={
				name.trim() === ""
					? undefined
					: addColumnSnql({ table, name, type, nullable, defaultExpr })
			}
			onClose={onClose}
		>
			{(locked) => (
				<>
					<TextInput
						size="xs"
						label="Nom"
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						autoComplete="off"
						disabled={locked}
						data-autofocus
						autoFocus
					/>
					<TypeSelect value={type} onChange={setType} disabled={locked} />
					<Checkbox
						size="xs"
						label="Nullable"
						checked={nullable}
						onChange={(e) => setNullable(e.currentTarget.checked)}
						disabled={locked}
					/>
					<TextInput
						size="xs"
						label="Défaut"
						value={defaultExpr}
						placeholder={DEFAULT_PLACEHOLDERS[type] ?? ""}
						onChange={(e) => setDefaultExpr(e.currentTarget.value)}
						autoComplete="off"
						disabled={locked}
					/>
				</>
			)}
		</ChangeFrame>
	);
}

/** Gestes d'une colonne existante. */
function ColumnPanel({
	gesture,
	onClose
}: {
	readonly gesture: ColumnGesture;
	readonly onClose: () => void;
}) {
	const { schema } = useCanvasData();
	// La colonne telle qu'à l'ouverture : le schéma relu après l'application
	// ne la connaît plus sous ce nom, ou plus du tout.
	const [field] = useState(() =>
		schema.collections
			.find((c) => c.name === gesture.table)
			?.fields.find((f) => f.name === gesture.column)
	);
	const { table, column } = gesture;
	switch (gesture.kind) {
		case "rename-column":
			return (
				<RenameColumnPanel table={table} column={column} onClose={onClose} />
			);
		case "set-type":
			return (
				<SetTypePanel
					table={table}
					column={column}
					current={field?.enumTypeName ?? field?.type ?? "unknown"}
					onClose={onClose}
				/>
			);
		case "set-nullability":
			return (
				<ChangeFrame
					icon={
						gesture.nullable ? (
							<IconCircleDashed {...ICON} />
						) : (
							<IconAsterisk {...ICON} />
						)
					}
					title={gesture.nullable ? "Rendre nullable" : "Rendre obligatoire"}
					table={table}
					column={column}
					source={setNullabilitySnql(table, column, gesture.nullable)}
					onClose={onClose}
				/>
			);
		case "set-default":
			return (
				<SetDefaultPanel
					table={table}
					column={column}
					field={field}
					onClose={onClose}
				/>
			);
		case "drop-default":
			return (
				<ChangeFrame
					icon={<IconEraser {...ICON} />}
					title="Retirer le défaut"
					table={table}
					column={column}
					source={dropDefaultSnql(table, column)}
					onClose={onClose}
				>
					{() => <CurrentDefault field={field} />}
				</ChangeFrame>
			);
		case "drop-column":
			return (
				<ChangeFrame
					icon={<IconColumnRemove {...ICON} />}
					title="Supprimer la colonne"
					table={table}
					column={column}
					source={dropColumnSnql(table, column)}
					onClose={onClose}
				/>
			);
	}
}

function RenameColumnPanel({
	table,
	column,
	onClose
}: {
	readonly table: string;
	readonly column: string;
	readonly onClose: () => void;
}) {
	const [name, setName] = useState("");
	const trimmed = name.trim();
	return (
		<ChangeFrame
			icon={<IconCursorText {...ICON} />}
			title="Renommer la colonne"
			table={table}
			column={column}
			source={
				trimmed === "" || trimmed === column
					? undefined
					: renameColumnSnql(table, column, name)
			}
			onClose={onClose}
		>
			{(locked) => (
				<TextInput
					size="xs"
					label="Nouveau nom"
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					autoComplete="off"
					disabled={locked}
					data-autofocus
					autoFocus
				/>
			)}
		</ChangeFrame>
	);
}

function SetTypePanel({
	table,
	column,
	current,
	onClose
}: {
	readonly table: string;
	readonly column: string;
	readonly current: string;
	readonly onClose: () => void;
}) {
	const [type, setType] = useState(current);
	return (
		<ChangeFrame
			icon={<IconTransform {...ICON} />}
			title="Changer le type"
			table={table}
			column={column}
			source={type === current ? undefined : setTypeSnql(table, column, type)}
			onClose={onClose}
		>
			{(locked) => (
				<TypeSelect
					value={type}
					current={current}
					onChange={setType}
					disabled={locked}
				/>
			)}
		</ChangeFrame>
	);
}

function SetDefaultPanel({
	table,
	column,
	field,
	onClose
}: {
	readonly table: string;
	readonly column: string;
	readonly field: Field | undefined;
	readonly onClose: () => void;
}) {
	const [defaultExpr, setDefaultExpr] = useState("");
	return (
		<ChangeFrame
			icon={<IconPencil {...ICON} />}
			title={field?.hasDefault ? "Changer le défaut" : "Ajouter un défaut"}
			table={table}
			column={column}
			source={
				defaultExpr.trim() === ""
					? undefined
					: setDefaultSnql(table, column, defaultExpr)
			}
			onClose={onClose}
		>
			{(locked) => (
				<>
					<CurrentDefault field={field} />
					<TextInput
						size="xs"
						label="Défaut"
						value={defaultExpr}
						placeholder={DEFAULT_PLACEHOLDERS[field?.type ?? ""] ?? ""}
						onChange={(e) => setDefaultExpr(e.currentTarget.value)}
						autoComplete="off"
						disabled={locked}
						data-autofocus
						autoFocus
					/>
				</>
			)}
		</ChangeFrame>
	);
}

/** Le défaut tel que la base l'exprime. */
function CurrentDefault({ field }: { readonly field: Field | undefined }) {
	if (field?.defaultExpr === undefined) return null;
	return (
		<Row label="Actuel">
			<Text size="xs" ff="monospace" style={BREAK_ANYWHERE}>
				{field.defaultExpr}
			</Text>
		</Row>
	);
}

/** Types SNQL et enums du schéma ; le type actuel en tête s'il n'en fait pas partie. */
function TypeSelect({
	value,
	current,
	onChange,
	disabled
}: {
	readonly value: string;
	readonly current?: string;
	readonly onChange: (type: string) => void;
	readonly disabled: boolean;
}) {
	const { schema } = useCanvasData();
	const options = [
		...COLUMN_TYPES,
		...((schema as unknown as SnqlSchemaModel).enums ?? []).map((e) => e.name)
	];
	return (
		<NativeSelect
			size="xs"
			label="Type"
			value={value}
			onChange={(e) => onChange(e.currentTarget.value)}
			disabled={disabled}
			data={
				current !== undefined && !options.includes(current)
					? [current, ...options]
					: options
			}
		/>
	);
}

/**
 * Ce que les gestes partagent : cible, mode, SNQL et DDL compilés,
 * avertissements, saisie qui confirme une suppression, application et
 * résultat. `source` absent : formulaire incomplet, rien à compiler.
 */
function ChangeFrame({
	icon,
	title,
	table,
	column,
	reference,
	source,
	onClose,
	children
}: {
	readonly icon: ReactNode;
	readonly title: string;
	readonly table: string;
	readonly column?: string;
	/** `table.colonne` référencée, pour une relation. */
	readonly reference?: string;
	readonly source: string | undefined;
	readonly onClose: () => void;
	/** Formulaire du geste, figé une fois le changement appliqué. */
	readonly children?: (locked: boolean) => ReactNode;
}) {
	const { schema, editMode, teamSlug, connectionId } = useCanvasData();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [typed, setTyped] = useState("");
	const [running, setRunning] = useState(false);
	const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
	// L'aperçu de ce qui est parti : recompilé sur le schéma relu, il ne
	// verrait plus la colonne renommée ou supprimée.
	const [sent, setSent] = useState<ChangePreview | null>(null);

	const live = useMemo(
		() =>
			source === undefined
				? undefined
				: previewChange(source, schema as unknown as SnqlSchemaModel, editMode),
		[source, schema, editMode]
	);
	const preview = sent ?? live;
	const done = outcome?.ok === true;

	// Noms que la base ne donne pas (ADR-039 D3) : le CLI les propose d'après
	// le modèle du projet, la saisie les remplace.
	const [named, setNamed] = useState<TunnelSchemaChangeNames>({});
	const [settled] = useDebouncedValue(source, 300);
	const proposed = useQuery({
		queryKey: ["schema-change-names", teamSlug, connectionId, settled],
		queryFn: () =>
			fetchChangeNames({ teamSlug, connectionId, source: settled ?? "" }),
		enabled:
			editMode.kind === "migrations" &&
			settled !== undefined &&
			settled === source &&
			live?.error === undefined &&
			!done,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0
	});

	const apply = async () => {
		if (source === undefined || preview === undefined) return;
		if (editMode.kind !== "direct" && editMode.kind !== "migrations") return;
		setRunning(true);
		const names = typedNames(named);
		const result = await applyChange({
			teamSlug,
			connectionId,
			mode: editMode.kind,
			source,
			...(names !== undefined ? { names } : {})
		});
		setRunning(false);
		setOutcome(result);
		if (result.ok) {
			setSent(preview);
			void queryClient.invalidateQueries({
				queryKey: ["schema", teamSlug, connectionId]
			});
			void queryClient.invalidateQueries({
				queryKey: projectStatusQueryKey(teamSlug, connectionId)
			});
		}
	};

	const ready =
		canApply(editMode) &&
		preview !== undefined &&
		preview.error === undefined &&
		(preview.confirm === undefined ||
			matchesExpected(typed, preview.confirm)) &&
		!running &&
		!done;

	return (
		<CanvasSidePanel
			icon={icon}
			title={title}
			onClose={onClose}
			footer={
				<Group justify="space-between" wrap="nowrap">
					<Button
						size="xs"
						variant="secondary"
						disabled={source === undefined}
						onClick={() =>
							void navigate({
								to: "/canvas/$connId/query",
								params: { connId: connectionId },
								search: { source }
							})
						}
					>
						Console
					</Button>
					{done ? (
						<Button size="xs" variant="secondary" onClick={onClose}>
							Fermer
						</Button>
					) : (
						<Button
							size="xs"
							variant="primary"
							disabled={!ready}
							loading={running}
							onClick={() => void apply()}
						>
							Appliquer
						</Button>
					)}
				</Group>
			}
		>
			<ScrollArea style={{ flex: 1 }} px="md" py="sm">
				<Stack gap="sm">
					<Row label="Table">
						<Text size="xs" ff="monospace">
							{table}
						</Text>
					</Row>
					{column !== undefined ? (
						<Row label="Colonne">
							<Text size="xs" ff="monospace">
								{column}
							</Text>
						</Row>
					) : null}
					{reference !== undefined ? (
						<Row label="Référence">
							<Text size="xs" ff="monospace" style={BREAK_ANYWHERE}>
								{reference}
							</Text>
						</Row>
					) : null}
					<Row label="Mode">
						<ModeLabel mode={editMode} />
					</Row>
					{canApply(editMode) ? (
						<>
							{children?.(done)}
							{proposed.data !== null && proposed.data !== undefined ? (
								<NamesFields
									proposed={proposed.data}
									named={named}
									onChange={setNamed}
									disabled={done}
								/>
							) : null}
							{proposed.error !== null ? (
								<Text size="xs" c="red">
									{proposed.error.message}
								</Text>
							) : null}
							{preview !== undefined ? (
								<>
									<Block label="SNQL">{source}</Block>
									{preview.error !== undefined ? (
										<Text size="xs" c="red">
											{preview.error}
										</Text>
									) : (
										<Block label="DDL">{preview.statements.join("\n")}</Block>
									)}
									{preview.warnings.map((w) => (
										<Text key={w} size="xs" c="yellow">
											{w}
										</Text>
									))}
									{preview.confirm !== undefined && !done ? (
										<TextInput
											size="xs"
											label={`Retapez : ${preview.confirm}`}
											value={typed}
											onChange={(e) => setTyped(e.currentTarget.value)}
											autoComplete="off"
										/>
									) : null}
								</>
							) : null}
						</>
					) : (
						<ClosedEditing mode={editMode} />
					)}
					{outcome !== null ? <Outcome outcome={outcome} /> : null}
				</Stack>
			</ScrollArea>
		</CanvasSidePanel>
	);
}

/**
 * Noms du modèle de l'ORM : la proposition du CLI en indication, un champ
 * laissé vide la garde.
 */
function NamesFields({
	proposed,
	named,
	onChange,
	disabled
}: {
	readonly proposed: TunnelSchemaChangeNames;
	readonly named: TunnelSchemaChangeNames;
	readonly onChange: (names: TunnelSchemaChangeNames) => void;
	readonly disabled: boolean;
}) {
	const relations = Object.entries(proposed.relations ?? {});
	const setRelation = (
		key: string,
		part: "field" | "back" | "name",
		value: string
	) =>
		onChange({
			...named,
			relations: {
				...named.relations,
				[key]: { ...named.relations?.[key], [part]: value }
			}
		});
	return (
		<>
			{proposed.model !== undefined ? (
				<TextInput
					size="xs"
					label="Modèle"
					value={named.model ?? ""}
					placeholder={proposed.model}
					onChange={(e) => onChange({ ...named, model: e.currentTarget.value })}
					autoComplete="off"
					disabled={disabled}
				/>
			) : null}
			{relations.map(([key, relation]) => (
				<Stack key={key} gap="sm">
					{relations.length > 1 ? (
						<Text size="xs" c="dimmed" ff="monospace" style={BREAK_ANYWHERE}>
							{key}
						</Text>
					) : null}
					{(
						[
							["field", "Champ de relation"],
							["back", "Champ retour"],
							["name", "Nom de relation"]
						] as const
					).map(([part, label]) =>
						relation[part] !== undefined ? (
							<TextInput
								key={part}
								size="xs"
								label={label}
								value={named.relations?.[key]?.[part] ?? ""}
								placeholder={relation[part]}
								onChange={(e) => setRelation(key, part, e.currentTarget.value)}
								autoComplete="off"
								disabled={disabled}
							/>
						) : null
					)}
				</Stack>
			))}
		</>
	);
}

function ModeLabel({ mode }: { readonly mode: EditMode }) {
	const text =
		mode.kind === "direct"
			? "Direct"
			: mode.kind === "migrations"
				? `Migration ${ORM_LABELS[mode.orm]}${mode.apply ? "" : " · base non touchée"}`
				: mode.kind === "blocked"
					? `${ORM_LABELS[mode.orm]} · édition fermée`
					: mode.kind === "pending"
						? "…"
						: "Indisponible";
	return <Text size="xs">{text}</Text>;
}

/** Pourquoi rien ne peut partir, et ce qui le débloque. */
function ClosedEditing({ mode }: { readonly mode: EditMode }) {
	if (mode.kind === "blocked" && mode.reason === "unlinked") {
		const command = `sqlnest link-project ${mode.connection ?? "<connexion>"} <dossier>`;
		return (
			<Stack gap={6}>
				<Text size="xs">
					Base gérée par {ORM_LABELS[mode.orm]} : relie son projet au CLI.
				</Text>
				<CopyButton value={command}>
					{({ copied, copy }) => (
						<Code
							block
							onClick={copy}
							style={{ cursor: "pointer", fontSize: "var(--sqlnest-font-size-11)" }}
							title={copied ? "Copié" : "Copier"}
						>
							{command}
						</Code>
					)}
				</CopyButton>
			</Stack>
		);
	}
	if (mode.kind === "blocked") {
		return (
			<Text size="xs">
				Dossier du projet {ORM_LABELS[mode.orm]} relié introuvable sur la
				machine du CLI.
			</Text>
		);
	}
	if (mode.kind === "unavailable") {
		return (
			<Text size="xs" c="red">
				{mode.message}
			</Text>
		);
	}
	return null;
}

function Outcome({ outcome }: { readonly outcome: ChangeOutcome }) {
	if (!outcome.ok) {
		return (
			<Block label="Échec" tone="red">
				{outcome.message}
			</Block>
		);
	}
	if (outcome.mode === "direct") {
		return (
			<Text size="xs" c="green">
				Appliqué.
			</Text>
		);
	}
	const { result } = outcome;
	return (
		<Stack gap={6}>
			<Text size="xs" c="green">
				{result.applied ? "Appliqué." : "Écrit, base non touchée."}
			</Text>
			{result.migration !== undefined ? (
				<Row label="Migration">
					<Text size="xs" ff="monospace" style={BREAK_ANYWHERE}>
						{result.migration}
					</Text>
				</Row>
			) : null}
			{result.files.map((file) => (
				<Text
					key={file}
					size="xs"
					ff="monospace"
					c="dimmed"
					style={BREAK_ANYWHERE}
				>
					{file}
				</Text>
			))}
			{result.checks.map((check) => (
				<Box key={check.name}>
					<Text
						size="xs"
						c={
							check.ok === true
								? "green"
								: check.ok === false
									? "red"
									: "dimmed"
						}
					>
						{CHECK_LABELS[check.name]} :{" "}
						{check.ok === true
							? "conforme"
							: check.ok === false
								? "écart"
								: `non exécuté — ${check.skipped ?? ""}`}
					</Text>
					{check.ok === false ? (
						<Code block style={{ fontSize: "var(--sqlnest-font-size-11)" }}>
							{check.diff ??
								(check.differences ?? [])
									.map(
										(d) =>
											`${d.subject} ${d.target}${d.name !== undefined ? `.${d.name}` : ""} : ${d.actual} (attendu : ${d.expected})`
									)
									.join("\n")}
						</Code>
					) : null}
				</Box>
			))}
		</Stack>
	);
}

function Row({
	label,
	children
}: {
	readonly label: string;
	readonly children: ReactNode;
}) {
	return (
		<Group gap="xs" wrap="nowrap" align="baseline">
			<Text size="xs" c="dimmed" w={64} style={{ flexShrink: 0 }}>
				{label}
			</Text>
			{children}
		</Group>
	);
}

function Block({
	label,
	tone,
	children
}: {
	readonly label: string;
	readonly tone?: "red";
	readonly children: ReactNode;
}) {
	return (
		<Stack gap={4}>
			<Text size="xs" c={tone ?? "dimmed"}>
				{label}
			</Text>
			<Code block style={{ fontSize: "var(--sqlnest-font-size-11)", whiteSpace: "pre-wrap" }}>
				{children}
			</Code>
		</Stack>
	);
}
