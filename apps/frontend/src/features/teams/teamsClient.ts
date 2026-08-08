/**
 * Client teams — fetch team perso par défaut + list. Utilisé au boot
 * pour rediriger depuis `/` vers `/team/:defaultSlug`.
 */

const API_BASE = window.CONTEXT.apiBaseUrl;

export interface TeamSummary {
	readonly id: string;
	readonly slug: string;
	readonly name: string;
	readonly createdAt: string;
}

/** GET /api/teams/me/default — team perso de l'user (créée lazy si
 *  absente, garantit qu'aucune signup n'atterrit sans team). */
export async function fetchDefaultTeam(): Promise<TeamSummary> {
	const res = await fetch(`${API_BASE}/api/teams/me/default`, {
		credentials: "include"
	});
	if (!res.ok) {
		const data = (await res.json().catch(() => ({}))) as { message?: string };
		throw new Error(data.message ?? `HTTP ${res.status}`);
	}
	return (await res.json()) as TeamSummary;
}

/** GET /api/teams/me — toutes les teams dont l'user est owner. */
export async function fetchMyTeams(): Promise<readonly TeamSummary[]> {
	const res = await fetch(`${API_BASE}/api/teams/me`, {
		credentials: "include"
	});
	if (!res.ok) {
		const data = (await res.json().catch(() => ({}))) as { message?: string };
		throw new Error(data.message ?? `HTTP ${res.status}`);
	}
	const parsed = (await res.json()) as { teams: readonly TeamSummary[] };
	return parsed.teams;
}

/** GET /api/teams/:slug — détails d'une team. 404 si l'user n'en est
 *  pas owner (isolation stricte, pas de distinction cross-user pour
 *  éviter la fuite d'existence). */
export async function fetchTeamBySlug(slug: string): Promise<TeamSummary> {
	const res = await fetch(`${API_BASE}/api/teams/${encodeURIComponent(slug)}`, {
		credentials: "include"
	});
	if (!res.ok) {
		const data = (await res.json().catch(() => ({}))) as { message?: string };
		throw new Error(data.message ?? `HTTP ${res.status}`);
	}
	return (await res.json()) as TeamSummary;
}
