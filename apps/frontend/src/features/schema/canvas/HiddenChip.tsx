import { UnstyledButton } from "@mantine/core";

export type HiddenChipProps = {
	count: number;
	onUnhideAll: () => void;
};

/**
 * Chip haut-centre — apparaît quand ≥1 table est masquée. Un clic
 * réaffiche toutes les tables cachées. Le rendu conditionnel (count > 0)
 * est laissé au parent.
 */
export function HiddenChip({ count, onUnhideAll }: HiddenChipProps) {
	const plural = count > 1 ? "s" : "";
	return (
		<UnstyledButton
			onClick={onUnhideAll}
			style={{
				position: "absolute",
				// 60 px = sous le CanvasBreadcrumb (top: 12, ~34 px de haut + gap).
				top: 60,
				left: "50%",
				transform: "translateX(-50%)",
				zIndex: 5,
				padding: "6px 12px",
				borderRadius: 999,
				background: "#fff",
				border: "1px solid var(--mantine-color-slate-2)",
				boxShadow: "var(--mantine-shadow-md)",
				fontSize: 12,
				fontWeight: 600,
				color: "var(--mantine-color-slate-7)",
			}}
		>
			{count} table{plural} masquée{plural} — tout réafficher
		</UnstyledButton>
	);
}
