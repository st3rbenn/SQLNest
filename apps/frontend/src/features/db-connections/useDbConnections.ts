import { useQuery } from "@tanstack/react-query";

const API_BASE = window.CONTEXT.apiBaseUrl;

/** Snapshot précalculé d'un rendu de preview — miroir du zod backend
 *  `PreviewSnapshotSchema`. Persisté par le frontend au save du canvas,
 *  réutilisé comme fallback quand le CLI est offline. Structure minimale
 *  (positions + edges + frames), le rendering se fait via le même
 *  `<PreviewSvg>` que quand le CLI est online → theme-aware. */
export interface PreviewSnapshot {
	readonly nodes: ReadonlyArray<{
		readonly id: string;
		readonly x: number;
		readonly y: number;
		readonly w: number;
		readonly h: number;
	}>;
	readonly edges: ReadonlyArray<{
		readonly source: string;
		readonly target: string;
	}>;
	readonly frames: ReadonlyArray<{
		readonly key: string;
		readonly label: string;
		readonly hue: number;
		readonly x: number;
		readonly y: number;
		readonly w: number;
		readonly h: number;
	}>;
}

/**
 * Métadonnées SÛRES d'une db_connection — miroir du zod backend
 * `ListDbConnectionsResponse` (packages/backend/src/domains/db-connections/schema.ts).
 * Jamais de DSN : les creds ne quittent pas la machine du CLI (règle 1 sécu).
 */
export interface DbConnection {
	readonly id: string;
	readonly name: string;
	readonly engine: string;
	readonly cliFingerprint: string;
	readonly engineMetadata: unknown;
	/** ISO. Depuis quand ce CLI est le pairing actif de la connection. */
	readonly activeSince: string;
	/** ISO ou null si jamais pingué depuis le dernier pairing. */
	readonly lastSeenAt: string | null;
	readonly createdAt: string;
	/** `true` si un CLI est actuellement connecté au tunnel WSS pour cette
	 *  connection (calc côté backend depuis le registry in-memory). Change
	 *  en temps quasi-réel via le poll `refetchInterval: 5s` du hook. */
	readonly isOnline: boolean;
	/** Snapshot du dernier rendu de preview. `null` tant que l'user n'a
	 *  pas ouvert le canvas au moins une fois. Sert de fallback rendu
	 *  quand le CLI est offline — la gallery affiche le dernier état connu
	 *  au lieu d'un « CLI hors ligne » vide. */
	readonly lastPreviewSnapshot: PreviewSnapshot | null;
}

interface ListResponse {
	readonly connections: readonly DbConnection[];
}

export async function fetchDbConnections(
	teamSlug: string | null
): Promise<readonly DbConnection[]> {
	// URL team-scoped si teamSlug est fourni (context router), sinon
	// fallback route legacy user-scoped (transitionnel).
	const url = teamSlug
		? `${API_BASE}/api/teams/${encodeURIComponent(teamSlug)}/db-connections`
		: `${API_BASE}/api/db-connections`;
	const res = await fetch(url, { credentials: "include" });
	if (!res.ok) {
		const data = (await res.json().catch(() => ({}))) as { message?: string };
		throw new Error(data.message ?? `HTTP ${res.status}`);
	}
	const parsed = (await res.json()) as ListResponse;
	return parsed.connections;
}

/**
 * Liste les `db_connection` du user courant + leur `isOnline` en quasi
 * temps réel (poll 2s). Alimente :
 *   - le sélecteur de connection,
 *   - l'empty-state qui invite à pairer un CLI via `/pair`,
 *   - les cards gallery qui affichent le mini-schema (auto-refetch quand
 *     `isOnline` passe false→true — voir MiniSchemaPreview),
 *   - `useTunnelPresenceNotifications` qui notifie les transitions.
 *
 * Latence des transitions on↔off visibles côté UI : 0-2s. Coût backend
 * = SELECT indexé + O(N) sur registry in-memory par tick. À terme,
 * migrer vers SSE + Redis pub/sub pour zéro latence sans polling.
 *
 * `teamSlug` : si fourni, appelle la route team-scoped ; sinon la route
 * legacy (transitionnel).
 */
export function useDbConnections(teamSlug: string | null = null) {
	return useQuery({
		queryKey: ["db-connections", teamSlug],
		queryFn: () => fetchDbConnections(teamSlug),
		retry: false,
		refetchOnWindowFocus: false,
		refetchInterval: 2000
	});
}
