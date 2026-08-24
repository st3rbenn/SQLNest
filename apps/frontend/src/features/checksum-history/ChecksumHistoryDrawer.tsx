import { Box, Button, Drawer, Group, Stack, Text } from "@mantine/core";
import { IconClockHour3, IconHistory } from "@tabler/icons-react";
import { useMemo } from "react";
import type { ChecksumHistoryEntry } from "./checksumHistoryClient";
import { groupByDay } from "./groupByDay";
import { useChecksumHistory } from "./useChecksumHistory";

interface Props {
	readonly opened: boolean;
	readonly onClose: () => void;
	readonly connectionId: string | null;
	readonly teamSlug: string | null;
}

/** Drawer bas coulissant — audit trail des events checksum du canvas courant. */
export function ChecksumHistoryDrawer({
	opened,
	onClose,
	connectionId,
	teamSlug
}: Props) {
	const query = useChecksumHistory(connectionId, teamSlug, { enabled: opened });
	const allEntries = useMemo<readonly ChecksumHistoryEntry[]>(() => {
		if (!query.data) return [];
		return query.data.pages.flatMap((p) => p?.entries ?? []);
	}, [query.data]);
	const groups = useMemo(() => groupByDay(allEntries), [allEntries]);

	return (
		<Drawer
			opened={opened}
			onClose={onClose}
			position="bottom"
			size="60%"
			withCloseButton
			title={
				<Group gap={8}>
					<IconHistory size={18} stroke={1.8} />
					<Text fw={600}>Historique du schéma</Text>
				</Group>
			}
			styles={{
				content: { background: "var(--sqlnest-surface)" },
				header: {
					background: "var(--sqlnest-surface)",
					borderBottom: "1px solid var(--sqlnest-border-subtle)"
				}
			}}
		>
			<Stack gap="lg" pt="sm">
				{query.isLoading && <Text c="dimmed" size="sm">Chargement…</Text>}
				{query.isError && (
					<Text c="red" size="sm">
						Impossible de charger l'historique.
					</Text>
				)}
				{!query.isLoading && !query.isError && allEntries.length === 0 && (
					<Text c="dimmed" size="sm">
						Aucun event pour cette connexion. Les changements de schéma
						s'affichent ici quand le CLI heartbeat les capte.
					</Text>
				)}
				{groups.map((g) => (
					<DayGroupBlock key={g.key} label={g.label} entries={g.entries} />
				))}
				{query.hasNextPage && (
					<Group justify="center" pt="xs">
						<Button
							variant="subtle"
							size="xs"
							loading={query.isFetchingNextPage}
							onClick={() => query.fetchNextPage()}
						>
							Voir plus
						</Button>
					</Group>
				)}
			</Stack>
		</Drawer>
	);
}

function DayGroupBlock({
	label,
	entries
}: {
	readonly label: string;
	readonly entries: readonly ChecksumHistoryEntry[];
}) {
	return (
		<Box>
			<Text
				size="xs"
				fw={600}
				c="dimmed"
				pb={6}
				style={{ textTransform: "uppercase", letterSpacing: 0.5 }}
			>
				{label}
			</Text>
			<Stack gap={2}>
				{entries.map((e) => (
					<EventRow key={e.id} entry={e} />
				))}
			</Stack>
		</Box>
	);
}

function EventRow({ entry }: { readonly entry: ChecksumHistoryEntry }) {
	const time = new Date(entry.seenAt).toLocaleTimeString("fr-FR", {
		hour: "2-digit",
		minute: "2-digit"
	});
	const shortChecksum = entry.dbSchemaChecksum.slice(0, 8);
	return (
		<Group
			gap="md"
			py={6}
			px={8}
			style={{
				borderRadius: 6,
				fontSize: 13
			}}
		>
			<Group gap={6} style={{ minWidth: 60 }}>
				<IconClockHour3 size={14} stroke={1.8} />
				<Text size="xs" c="dimmed">
					{time}
				</Text>
			</Group>
			<Text
				size="xs"
				ff="monospace"
				c="var(--sqlnest-text-primary)"
				style={{ letterSpacing: 0.2 }}
			>
				{shortChecksum}
			</Text>
			{entry.dbConnectionId === null && (
				<Text size="xs" c="dimmed" fs="italic">
					(device supprimé)
				</Text>
			)}
		</Group>
	);
}
