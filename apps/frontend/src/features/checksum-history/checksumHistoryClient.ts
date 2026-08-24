/**
 * Client fetch pour `GET /api/teams/:slug/canvas-state/checksum-history`.
 *
 * Pagination cursor keyset : le cursor opaque encode `(seen_at, id)` de la
 * dernière row de la page précédente. `nextCursor: null` = dernière page.
 * Réutilise le même index PG que la timeline DESC, O(log N) constant.
 */

export interface ChecksumHistoryEntry {
	readonly id: string;
	readonly dbSchemaChecksum: string;
	readonly dbConnectionId: string | null;
	readonly seenAt: string;
}

export interface ChecksumHistoryResponse {
	readonly canvasId: string;
	readonly entries: readonly ChecksumHistoryEntry[];
	readonly nextCursor: string | null;
}

function endpoint(teamSlug: string): string {
	return `${window.CONTEXT.apiBaseUrl}/api/teams/${encodeURIComponent(teamSlug)}/canvas-state/checksum-history`;
}

export async function fetchChecksumHistory(
	connectionId: string,
	teamSlug: string,
	options: { readonly cursor?: string; readonly limit?: number } = {}
): Promise<ChecksumHistoryResponse | null> {
	const params = new URLSearchParams({ connectionId });
	if (options.cursor !== undefined) params.set("cursor", options.cursor);
	if (options.limit !== undefined) params.set("limit", String(options.limit));
	const url = `${endpoint(teamSlug)}?${params.toString()}`;
	const res = await fetch(url, {
		method: "GET",
		credentials: "include"
	});
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(`checksum-history GET failed: HTTP ${res.status}`);
	}
	return (await res.json()) as ChecksumHistoryResponse;
}
