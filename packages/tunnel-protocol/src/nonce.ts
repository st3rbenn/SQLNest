/**
 * Protection anti-replay — counter monotone + skew timestamp.
 *
 * ─── Modèle ───────────────────────────────────────────────────────────
 * Chaque peer maintient un `PeerCounterState` par (session, peer) qui
 * garde le dernier `ctr` accepté et la dernière `ts` vue. À chaque
 * frame entrante :
 *   1. `header.ctr` doit être STRICTEMENT SUPÉRIEUR au dernier vu.
 *      (Un attaquant qui rejoue une frame passée voit son `ctr` ≤
 *      dernier accepté → rejet).
 *   2. `header.ts` doit être dans `[now - MAX_SKEW_MS, now + MAX_SKEW_MS]`.
 *      (Rejette les frames trop vieilles ou du futur — protection
 *      contre les horloges déréglées + replay tardif).
 *
 * ─── Alternative non retenue ──────────────────────────────────────────
 * Nonce cache (Set des nonces vues, purge périodique) : plus riche mais
 * coûteux en mémoire et complexe à raisonner sur les fenêtres. Counter
 * monotone couvre le même modèle de menace pour notre cas — chaque WS
 * est une session distincte, le counter reset à 0 à la reconnexion.
 */

import { MAX_SKEW_MS } from "./types";

/** État côté récepteur pour un peer donné. */
export interface PeerCounterState {
	lastCtr: number;
	lastTs: number;
}

/** Résultat de la vérif — discriminated pour que le caller sache
 *  pourquoi c'est refusé (log / audit). */
export type CounterCheckResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: CounterCheckFailure };

export type CounterCheckFailure =
	| "counter_reused"
	| "counter_backward"
	| "timestamp_too_old"
	| "timestamp_too_new";

/**
 * Crée un `PeerCounterState` initial — accepte le premier `ctr` reçu
 * (typiquement 1 après handshake).
 */
export function createPeerCounter(): PeerCounterState {
	return { lastCtr: -1, lastTs: 0 };
}

/**
 * Valide un `ctr` et `ts` reçus. Si OK, MUTE le `state` avec les
 * nouvelles valeurs. Sinon retourne la raison sans mutation.
 *
 * ─── Mutation ─────────────────────────────────────────────────────────
 * La mutation en cas de succès est intentionnelle — c'est comment on
 * enforce la monotonie. Le caller passe un state persistant par peer.
 */
export function checkAndAdvance(
	state: PeerCounterState,
	ctr: number,
	ts: number,
	now: number = Date.now(),
	maxSkewMs: number = MAX_SKEW_MS
): CounterCheckResult {
	if (ctr === state.lastCtr) {
		return { ok: false, reason: "counter_reused" };
	}
	if (ctr < state.lastCtr) {
		return { ok: false, reason: "counter_backward" };
	}
	if (ts < now - maxSkewMs) {
		return { ok: false, reason: "timestamp_too_old" };
	}
	if (ts > now + maxSkewMs) {
		return { ok: false, reason: "timestamp_too_new" };
	}
	state.lastCtr = ctr;
	state.lastTs = ts;
	return { ok: true };
}

/**
 * État côté ÉMETTEUR — un compteur monotone incrémenté à chaque envoi.
 * Reset à 0 au handshake d'une nouvelle session.
 */
export interface EmitterCounterState {
	next: number;
}

export function createEmitterCounter(): EmitterCounterState {
	return { next: 0 };
}

/** Retourne le prochain `ctr` à mettre dans `header.ctr` puis
 *  incrémente. Le premier appel retourne 0. */
export function nextCounter(state: EmitterCounterState): number {
	const c = state.next;
	state.next += 1;
	return c;
}
