import { ActionIcon, Group, Kbd, Paper, Text } from "@mantine/core";

export type SelectionChipAction = {
	id: string;
	label: string;
	hint?: string;
	danger?: boolean;
	onClick: () => void;
};

export type SelectionChipProps = {
	count: number;
	label: string;
	actions: readonly SelectionChipAction[];
	onClear: () => void;
};

/**
 * Pill sombre bas-centre — compteur de sélection + actions rapides
 * (Frame, Masquer, …). Reprend le pattern mockup 1c. Réutilisable pour
 * toute sélection multi-items future (edges, cellules d'un ResultSet, …).
 */
export function SelectionChip({
	count,
	label,
	actions,
	onClear
}: SelectionChipProps) {
	const isPlural = count > 1;
	const feminine = /^table/i.test(label);
	const noun = isPlural && !label.endsWith("s") ? `${label}s` : label;
	const verb = feminine
		? isPlural
			? "sélectionnées"
			: "sélectionnée"
		: isPlural
			? "sélectionnés"
			: "sélectionné";
	const summary = `${count} ${noun} ${verb}`;
	return (
		<Paper
			radius="xl"
			shadow="lg"
			style={{
				background: "var(--mantine-color-slate-9)",
				color: "#fff",
				padding: "8px 14px"
			}}
		>
			<Group gap={12} wrap="nowrap">
				<Group gap={6} wrap="nowrap">
					<span
						style={{
							width: 6,
							height: 6,
							borderRadius: "50%",
							background: "var(--mantine-color-brand-4)"
						}}
					/>
					<Text size="xs" c="white">
						{summary}
					</Text>
				</Group>
				{actions.length > 0 ? (
					<span
						style={{
							width: 1,
							height: 14,
							background: "var(--mantine-color-slate-7)"
						}}
					/>
				) : null}
				{actions.map((a) => (
					<button
						key={a.id}
						type="button"
						onClick={a.onClick}
						style={{
							border: "none",
							background: "transparent",
							color: a.danger ? "var(--mantine-color-red-3)" : "#fff",
							fontSize: 12,
							fontFamily: "inherit",
							cursor: "pointer",
							padding: "2px 6px",
							borderRadius: 5,
							display: "inline-flex",
							alignItems: "center",
							gap: 6
						}}
					>
						{a.label}
						{a.hint ? <Kbd size="xs">{a.hint}</Kbd> : null}
					</button>
				))}
				<ActionIcon
					variant="subtle"
					color="gray"
					size="sm"
					onClick={onClear}
					aria-label="Fermer la sélection"
					style={{ color: "var(--mantine-color-slate-4)" }}
				>
					✕
				</ActionIcon>
			</Group>
		</Paper>
	);
}
