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
import { ORM_LABELS, type TunnelSchemaCheck } from "@sqlnest/tunnel-protocol";
import { IconColumnInsertRight } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { useCanvasData, useCanvasUI } from "../canvas/CanvasContext";
import { CanvasSidePanel } from "../canvas/floating/CanvasSidePanel";
import { applyChange, type ChangeOutcome } from "./applyChange";
import { previewChange } from "./changePreview";
import { addColumnSnql, COLUMN_TYPES } from "./changeSnql";
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

/**
 * Panneau d'un changement de schéma (ADR-039 D3 à D5) : formulaire du geste,
 * SNQL, DDL, avertissements, puis résultat de l'application.
 */
export function ChangePanel() {
	const { gesture, setGesture } = useCanvasUI();
	if (gesture === null) return null;
	return (
		<AddColumnPanel
			key={gesture.table}
			table={gesture.table}
			onClose={() => setGesture(null)}
		/>
	);
}

function AddColumnPanel({
	table,
	onClose
}: {
	readonly table: string;
	readonly onClose: () => void;
}) {
	const { schema, editMode, teamSlug, connectionId } = useCanvasData();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [type, setType] = useState<string>("string");
	const [nullable, setNullable] = useState(true);
	const [defaultExpr, setDefaultExpr] = useState("");
	const [running, setRunning] = useState(false);
	const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);

	const enums = (schema as unknown as SnqlSchemaModel).enums ?? [];
	const source = addColumnSnql({ table, name, type, nullable, defaultExpr });
	const preview = useMemo(
		() =>
			name.trim() === ""
				? undefined
				: previewChange(source, schema as unknown as SnqlSchemaModel, editMode),
		[name, source, schema, editMode]
	);

	const apply = async () => {
		if (editMode.kind !== "direct" && editMode.kind !== "migrations") return;
		setRunning(true);
		const result = await applyChange({
			teamSlug,
			connectionId,
			mode: editMode.kind,
			source
		});
		setRunning(false);
		setOutcome(result);
		if (result.ok) {
			void queryClient.invalidateQueries({
				queryKey: ["schema", teamSlug, connectionId]
			});
			void queryClient.invalidateQueries({
				queryKey: projectStatusQueryKey(teamSlug, connectionId)
			});
		}
	};

	const done = outcome?.ok === true;
	const ready =
		canApply(editMode) &&
		preview !== undefined &&
		preview.error === undefined &&
		!running &&
		!done;

	return (
		<CanvasSidePanel
			icon={
				<IconColumnInsertRight
					size={15}
					color="var(--sqlnest-text-secondary)"
				/>
			}
			title="Ajouter une colonne"
			onClose={onClose}
			footer={
				<Group justify="space-between" wrap="nowrap">
					<Button
						size="xs"
						variant="secondary"
						disabled={name.trim() === ""}
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
					<Row label="Mode">
						<ModeLabel mode={editMode} />
					</Row>
					{canApply(editMode) ? (
						<>
							<TextInput
								size="xs"
								label="Nom"
								value={name}
								onChange={(e) => setName(e.currentTarget.value)}
								autoComplete="off"
								disabled={done}
								data-autofocus
								autoFocus
							/>
							<NativeSelect
								size="xs"
								label="Type"
								value={type}
								onChange={(e) => setType(e.currentTarget.value)}
								disabled={done}
								data={[
									...COLUMN_TYPES,
									...enums.map((e) => ({ value: e.name, label: e.name }))
								]}
							/>
							<Checkbox
								size="xs"
								label="Nullable"
								checked={nullable}
								onChange={(e) => setNullable(e.currentTarget.checked)}
								disabled={done}
							/>
							<TextInput
								size="xs"
								label="Défaut"
								value={defaultExpr}
								placeholder={DEFAULT_PLACEHOLDERS[type] ?? ""}
								onChange={(e) => setDefaultExpr(e.currentTarget.value)}
								autoComplete="off"
								disabled={done}
							/>
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
							style={{ cursor: "pointer", fontSize: 11 }}
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
						<Code block style={{ fontSize: 11 }}>
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
			<Code block style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>
				{children}
			</Code>
		</Stack>
	);
}
