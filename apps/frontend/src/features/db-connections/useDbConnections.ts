import { useQuery } from "@tanstack/react-query";

const API_BASE = window.CONTEXT.apiBaseUrl;

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
}

interface ListResponse {
	readonly connections: readonly DbConnection[];
}

async function fetchDbConnections(): Promise<readonly DbConnection[]> {
	const res = await fetch(`${API_BASE}/api/db-connections`, {
		credentials: "include"
	});
	if (!res.ok) {
		const data = (await res.json().catch(() => ({}))) as { message?: string };
		throw new Error(data.message ?? `HTTP ${res.status}`);
	}
	const parsed = (await res.json()) as ListResponse;
	return parsed.connections;
}

/**
 * Liste les `db_connection` du user courant + leur `isOnline` en quasi
 * temps réel (poll 5s). Alimente :
 *   - le sélecteur de connection,
 *   - l'empty-state qui invite à pairer un CLI via `/connect`,
 *   - les cards gallery qui affichent le mini-schema (auto-refetch quand
 *     `isOnline` passe false→true — voir MiniSchemaPreview).
 *
 * Le poll 5s est intentionnellement fréquent : les cards gallery ont besoin
 * de savoir vite quand un CLI reconnecte pour ré-fetch le mini-schema.
 * Coût backend négligeable (SELECT indexé + O(N) sur registry).
 */
export function useDbConnections() {
	return useQuery({
		queryKey: ["db-connections"],
		queryFn: fetchDbConnections,
		retry: false,
		refetchOnWindowFocus: false,
		refetchInterval: 5000
	});
}
