import type { ChecksumHistoryEntry } from "./checksumHistoryClient";

export interface DayGroup {
	readonly key: string;
	readonly label: string;
	readonly entries: readonly ChecksumHistoryEntry[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function labelFor(day: Date, today: Date): string {
	const dayStart = startOfDay(day).getTime();
	const todayStart = startOfDay(today).getTime();
	if (dayStart === todayStart) return "Aujourd'hui";
	if (todayStart - dayStart === DAY_MS) return "Hier";
	return day.toLocaleDateString("fr-FR", {
		day: "numeric",
		month: "short",
		year: day.getFullYear() === today.getFullYear() ? undefined : "numeric"
	});
}

/**
 * Regroupe les events par jour local, préserve l'ordre décroissant (dernier
 * en tête). Un event à cheval sur minuit est rangé selon sa date locale
 * (heure user), pas UTC — la question "quand mon schéma a bougé" fait sens
 * dans le fuseau local, pas UTC.
 */
export function groupByDay(
	entries: readonly ChecksumHistoryEntry[],
	now: Date = new Date()
): readonly DayGroup[] {
	const buckets = new Map<string, ChecksumHistoryEntry[]>();
	for (const e of entries) {
		const d = new Date(e.seenAt);
		const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
		const bucket = buckets.get(key);
		if (bucket) bucket.push(e);
		else buckets.set(key, [e]);
	}
	const groups: DayGroup[] = [];
	for (const [key, bucketEntries] of buckets) {
		const firstDate = new Date(bucketEntries[0]!.seenAt);
		groups.push({
			key,
			label: labelFor(firstDate, now),
			entries: bucketEntries
		});
	}
	return groups;
}
