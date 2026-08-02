/**
 * Sync serveur du state canvas (positions / sizes / frames / hidden).
 *
 * Rôle : au mount, hydrate depuis `/api/canvas-state?signature=...` (200 → apply
 * en écrasant l'état localStorage courant SI l'user n'a rien touché pendant le
 * fetch ; 404 / erreur / divergence détectée → garde le local). Puis observe
 * les 4 slices, debounce 2 s au moindre changement, et pousse un snapshot
 * complet via PUT. Un flush pré-unmount (cleanup + visibilitychange + pagehide
 * + beforeunload) force l'envoi avec `keepalive: true` pour survivre à la
 * fermeture d'onglet.
 *
 * Gate : `useCurrentUser()` — anonyme = no-op complet, on retombe sur la
 * persistance localStorage des 4 hooks sous-jacents (déjà en place).
 *
 * ─── Race hydratation ↔ push ───────────────────────────────────────────
 * Trois races traitées :
 *  1. User bouge pendant le fetch → replaceAll(server) écraserait ses gestes.
 *     → snapshot `currentSerialized` au démarrage du fetch, compare au settle.
 *       Si différent → l'user a divergé → traite comme un 404 (préserve local,
 *       baseline = payload vide → prochain compare push le local vers serveur).
 *  2. 404 baseline = local → 1er changement local n'est jamais push si
 *     `positions`/etc. sont restés identiques au moment du 404 (ex. état
 *     rechargé du localStorage).
 *     → baseline sur 404 = payload VIDE : garantit qu'un state local non-vide
 *       (repli localStorage) déclenche le PUT immédiat pour créer la 1ère row.
 *  3. Timer débounce armé pendant que le fetch tournait → au 200 il finirait
 *     par écraser la baseline server avec un état stale.
 *     → au 200 réussi, on annule le timer (`clearTimeout` +
 *       `pendingSerializedRef = null`) avant de poser la baseline.
 *
 * Non-goals v1 : conflit multi-onglets, spinner UI dédié, invalidation croisée
 * de la queryKey (éviterait la loop refetch → replaceAll → useEffect → push).
 */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCurrentUser } from "../../auth/sessionQuery";
import type { Frame } from "../frames";
import type { AnchorMap } from "../useEdgeAnchors";
import type { PositionsMap } from "../useTablePositions";
import type { SizesMap } from "../useTableSizes";
import { type CanvasSources, deserialize, serialize } from "./canvasPayload";
import { fetchCanvasState, putCanvasState } from "./canvasStateClient";

/** Délai avant push serveur après la dernière modification (ms). */
export const CANVAS_SYNC_DEBOUNCE_MS = 2000;

/**
 * Seuil sécurité `fetch({ keepalive: true })` — spec HTML limite le total des
 * bodies keepalive en vol à 64 KiB par origin. Au-delà, le browser drop la
 * request silencieusement. On garde ~4 KB de marge pour le wrapping
 * `{signature, payload}` + les headers.
 */
const KEEPALIVE_MAX_BODY_BYTES = 60_000;

/**
 * État affichable du sync :
 * - `idle`    → à jour avec le serveur (ou pas encore de push)
 * - `saving`  → un PUT est en vol
 * - `error`   → un PUT a échoué (mais on retentera au prochain changement)
 * - `offline` → l'hydratation initiale a échoué (mode dégradé, seul le
 *   localStorage garde l'état ; pas de push tenté)
 */
export type SyncStatus = "idle" | "saving" | "error" | "offline";

export interface CanvasSyncReplaceAll {
	readonly positions: (positions: PositionsMap) => void;
	readonly sizes: (sizes: SizesMap) => void;
	readonly frames: (frames: readonly Frame[]) => void;
	readonly hidden: (hidden: ReadonlySet<string>) => void;
	readonly edgeAnchors: (overrides: AnchorMap) => void;
}

export interface UseCanvasSyncOptions extends CanvasSources {
	readonly signature: string;
	readonly replaceAll: CanvasSyncReplaceAll;
}

export interface UseCanvasSyncReturn {
	readonly syncStatus: SyncStatus;
	readonly lastSavedAt: string | null;
	/**
	 * `true` quand le canvas est prêt à s'afficher sans flick :
	 *   - user anonyme → true immédiatement (pas de fetch server)
	 *   - user loggé → true dès que le GET /canvas-state a settle (200/404/erreur)
	 *     ET que replaceAll (ou skip si divergence) a été appelé.
	 * Le parent gate le rendu du canvas visuel sur ce flag — sans ça on voit
	 * brièvement l'état localStorage puis un saut vers l'état serveur.
	 */
	readonly ready: boolean;
}

/** Sérialisation stable d'un payload vide (baseline post-404). */
const EMPTY_SERIALIZED = JSON.stringify(
	serialize({
		positions: {} as PositionsMap,
		sizes: {} as SizesMap,
		frames: [] as readonly Frame[],
		hidden: new Set<string>(),
		edgeAnchors: {} as AnchorMap
	})
);

/** Un push planifié : capture la paire {signature, serialized} au moment de
 * l'armement du timer. Sans capture, un changement de signature pendant le
 * débounce enverrait le vieux payload avec la NOUVELLE signature — payload
 * appliqué au mauvais schéma côté serveur. */
interface PendingPush {
	readonly signature: string;
	readonly serialized: string;
}

export function useCanvasSync(opts: UseCanvasSyncOptions): UseCanvasSyncReturn {
	const { data: session } = useCurrentUser();
	const user = session?.user ?? null;
	const enabled = user !== null && opts.signature.length > 0;

	const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
	const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

	// ─── Refs de coordination ─────────────────────────────────────────────
	// `hydrated` : passe à true dès que la query settle (data / null /
	// erreur). Bloque le push tant qu'on n'a pas comparé à l'état serveur —
	// sinon on push l'état localStorage initial dès le 1er render, sans
	// vérifier s'il matche déjà ce que le serveur détient.
	//
	// State (pas ref) — la transition false→true DOIT retrigger le push
	// effect via ses deps. Avec un ref, aucune re-render, et le premier PUT
	// après un 404 (ou une divergence H1) ne partait jamais.
	const [hydrated, setHydrated] = useState(false);
	// `lastSyncedSerializedRef` : sérialisation (JSON string) du dernier
	// snapshot connu comme « en phase » avec le serveur. Mises à jour :
	//   1. hydratation 200 (sans divergence détectée) → sérialisation du
	//      payload serveur qu'on vient d'appliquer via replaceAll.
	//   2. hydratation 404 OU divergence détectée → EMPTY_SERIALIZED
	//      (garantit que tout state local non-vide se pousse au prochain
	//      compare, y compris pour créer la 1ère row).
	//   3. après un PUT réussi → sérialisation du payload envoyé.
	// Comparé au `currentSerialized` à chaque rerender : si égal, pas de push.
	const lastSyncedSerializedRef = useRef<string | null>(null);
	// `debounceTimeoutRef` : id du setTimeout pending. `null` = pas de push
	// en attente. Reset à chaque nouveau change (repousse l'échéance de 2 s).
	const debounceTimeoutRef = useRef<number | null>(null);
	// `pendingPushRef` : dernier push planifié (paire {signature, serialized}).
	// Utilisée par (a) le timeout au fire pour envoyer la version la plus
	// fraîche, et (b) le flush pré-unmount / beforeunload pour envoyer
	// immédiatement. La signature est captée au moment de l'armement — évite
	// d'envoyer un vieux payload avec une nouvelle signature.
	const pendingPushRef = useRef<PendingPush | null>(null);
	// `fetchStartSerializedRef` : snapshot du `currentSerialized` au moment
	// où le fetch d'hydratation démarre. Utilisé au settle pour détecter si
	// l'user a modifié le state pendant que la requête était en vol. `null`
	// tant que le premier fetch n'a pas été enregistré.
	const fetchStartSerializedRef = useRef<string | null>(null);

	// ─── Refs de closures stables (callbacks + valeurs volatiles) ─────────
	// `replaceAllRef` : évite de re-fire l'effet d'hydratation à chaque render
	// (l'objet `opts.replaceAll` change d'identité même quand les fonctions
	// sous-jacentes sont stables via useCallback).
	const replaceAllRef = useRef(opts.replaceAll);
	replaceAllRef.current = opts.replaceAll;
	// `signatureRef` : NE PAS synchroniser en eager (avant effets) — sinon un
	// push effect qui fire dans le MÊME render qu'un changement de signature
	// captera la NOUVELLE signature avec l'ANCIEN payload. La sync se fait
	// dans l'effet dédié `signature-change` ci-dessous, après flush du
	// pending push de l'ancien schéma.
	const signatureRef = useRef(opts.signature);

	// ─── Query hydratation ────────────────────────────────────────────────
	// `staleTime: Infinity` + `retry: false` : on ne veut PAS que RQ refetch
	// après le mount. Un refetch → hydratation refire → replaceAll écrase
	// les gestes user depuis le mount → chaos. L'hydratation est one-shot.
	const query = useQuery({
		queryKey: ["canvas-state", opts.signature],
		queryFn: () => fetchCanvasState(opts.signature),
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		retry: false,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false
	});

	// ─── Signature change : flush + reset (avant tout le reste) ──────────
	// Quand l'user navigue d'un schéma à un autre :
	//  1. Si un push est débounce en attente pour l'ANCIEN schéma → on le
	//     flush IMMÉDIATEMENT avec l'ancienne signature (les modifications
	//     appartiennent à l'ancien schéma).
	//  2. On reset tout l'état d'hydratation (baseline, snapshot fetch-start,
	//     hydrated) — le nouveau queryKey déclenche un fetch neuf, et
	//     l'hydratation redémarre à zéro pour le nouveau schéma.
	//  3. On aligne `signatureRef` sur la nouvelle signature APRÈS le flush.
	const previousSignatureRef = useRef(opts.signature);
	useEffect(() => {
		if (previousSignatureRef.current === opts.signature) return;
		const oldPending = pendingPushRef.current;
		if (debounceTimeoutRef.current !== null) {
			window.clearTimeout(debounceTimeoutRef.current);
			debounceTimeoutRef.current = null;
		}
		pendingPushRef.current = null;
		setHydrated(false);
		lastSyncedSerializedRef.current = null;
		fetchStartSerializedRef.current = null;
		previousSignatureRef.current = opts.signature;
		signatureRef.current = opts.signature;
		if (oldPending !== null) {
			void doPushRef.current(oldPending);
		}
	}, [opts.signature]);

	// ─── Serialization du state courant ───────────────────────────────────
	// Recalculée à chaque render où l'une des 4 sources change. On garde
	// la version string (pour la comparaison via `===`) ET la version
	// snapshot (pour la passer telle quelle à putCanvasState).
	const currentSerialized = useMemo(
		() =>
			JSON.stringify(
				serialize({
					positions: opts.positions,
					sizes: opts.sizes,
					frames: opts.frames,
					hidden: opts.hidden,
					edgeAnchors: opts.edgeAnchors
				})
			),
		[opts.positions, opts.sizes, opts.frames, opts.hidden, opts.edgeAnchors]
	);
	const currentSerializedRef = useRef(currentSerialized);
	currentSerializedRef.current = currentSerialized;

	// ─── Snapshot du state au démarrage du fetch ──────────────────────────
	// Fire dès que la query passe à `isFetching` (avant le settle) — capture
	// une baseline utilisée au settle pour détecter les gestes user
	// concurrents.
	useEffect(() => {
		if (!enabled) return;
		if (hydrated) return;
		if (!query.isFetching) return;
		if (fetchStartSerializedRef.current !== null) return;
		fetchStartSerializedRef.current = currentSerializedRef.current;
	}, [enabled, query.isFetching, hydrated]);

	// ─── Effet d'hydratation (one-shot) ───────────────────────────────────
	// Effet séparé du push — hydrate dès que la query settle, quelle que
	// soit l'issue. Écrit lastSyncedSerializedRef pour amorcer la comparaison
	// du push effect ci-dessous.
	useEffect(() => {
		if (!enabled) return;
		if (hydrated) return;
		// Attendre que la query settle (success ou error, plus de fetching).
		if (query.isPending || query.isFetching) return;

		// H3 : annuler tout push débounce armé pendant la fenêtre de fetch —
		// son payload est stale par rapport à la baseline serveur qu'on
		// s'apprête à poser. Le prochain compare rearmera si nécessaire.
		if (debounceTimeoutRef.current !== null) {
			window.clearTimeout(debounceTimeoutRef.current);
			debounceTimeoutRef.current = null;
		}
		pendingPushRef.current = null;

		if (query.isError) {
			// Réseau HS / 5xx → mode offline : on garde l'état localStorage
			// vivant, on n'écrit rien serveur (jusqu'au prochain mount) —
			// mais on marque comme hydraté pour ne pas rester bloqué. La
			// baseline vide fait qu'aucun push n'est tenté tant que le
			// status est "offline" (guard sur le push effect ci-dessous).
			setSyncStatus("offline");
			lastSyncedSerializedRef.current = EMPTY_SERIALIZED;
			setHydrated(true);
			return;
		}

		if (query.data !== null && query.data !== undefined) {
			// H1 : si l'user a modifié le state pendant que le fetch tournait,
			// NE PAS écraser ses gestes avec la version serveur. On tombe
			// dans la branche 404-like (préserve local + baseline vide) — le
			// prochain compare push le local (avec les changements user
			// concurrents) vers le serveur.
			const startSnap = fetchStartSerializedRef.current;
			const userTouched =
				startSnap !== null && startSnap !== currentSerializedRef.current;

			if (userTouched) {
				lastSyncedSerializedRef.current = EMPTY_SERIALIZED;
				setHydrated(true);
				return;
			}

			// 200 sans divergence → applique le payload serveur en écrasant
			// l'état local. Les 4 hooks ré-persistent immédiatement au
			// localStorage via leur useEffect [state], donc l'écrasement est
			// aussi durable côté local sans action supplémentaire.
			const state = deserialize(query.data.payload);
			replaceAllRef.current.positions(state.positions);
			replaceAllRef.current.sizes(state.sizes);
			replaceAllRef.current.frames(state.frames);
			replaceAllRef.current.hidden(state.hidden);
			replaceAllRef.current.edgeAnchors(state.edgeAnchors);
			// Baseline = ce qu'on vient d'appliquer. Le prochain render aura
			// `currentSerialized` égal à cette valeur → pas de push spurious.
			lastSyncedSerializedRef.current = JSON.stringify(serialize(state));
			setLastSavedAt(query.data.updatedAt);
			setSyncStatus("idle");
		} else {
			// H2 : 404 → aucun état serveur. Baseline = payload VIDE (pas
			// `currentSerialized`) — garantit qu'un état local non-vide
			// (repli localStorage) déclenche immédiatement le PUT pour
			// créer la 1ère row.
			lastSyncedSerializedRef.current = EMPTY_SERIALIZED;
		}
		setHydrated(true);
	}, [
		enabled,
		query.isPending,
		query.isFetching,
		query.isError,
		query.data,
		hydrated
	]);

	// ─── Push effectif (async, met à jour lastSyncedSerializedRef) ────────
	// Pas de useMutation — plus simple à orchestrer avec le debounce timer
	// + le flush pré-unmount (qui doit pouvoir déclencher sans le hook
	// React de RQ).
	const doPush = useCallback(async (pending: PendingPush): Promise<void> => {
		setSyncStatus("saving");
		try {
			const payload = JSON.parse(pending.serialized) as Record<string, unknown>;
			// Utilise la signature captée au moment de l'armement — évite
			// qu'un changement de schéma pendant le débounce fasse partir
			// le payload avec la mauvaise signature.
			const result = await putCanvasState(pending.signature, payload);
			// Baseline mise à jour APRÈS confirmation du serveur : si un autre
			// change arrive entre-temps, le comparateur du push effect verra
			// bien la divergence et reschedulera.
			lastSyncedSerializedRef.current = pending.serialized;
			setLastSavedAt(result.updatedAt);
			setSyncStatus("idle");
		} catch {
			// On ne verrouille PAS le hook après une erreur : au prochain
			// changement (nouveau geste user), le debounce reprogrammera un
			// push. `error` reste affiché jusqu'au prochain succès.
			setSyncStatus("error");
		}
	}, []);
	const doPushRef = useRef(doPush);
	doPushRef.current = doPush;

	// ─── Effet debounce push ──────────────────────────────────────────────
	// Fire quand `currentSerialized` change ET diverge de la baseline. Un
	// change en rafale (drag qui dispatche N mousemoves) reset le timeout à
	// chaque tick — un seul push part 2 s après le dernier change.
	useEffect(() => {
		if (!enabled) return;
		if (!hydrated) return;
		if (syncStatus === "offline") return;
		if (lastSyncedSerializedRef.current === null) return;
		if (currentSerialized === lastSyncedSerializedRef.current) return;

		if (debounceTimeoutRef.current !== null) {
			window.clearTimeout(debounceTimeoutRef.current);
		}
		// Capture (signature, serialized) au moment de l'armement — cf. bloc
		// PendingPush ci-dessus pour le rationale.
		const pending: PendingPush = {
			signature: signatureRef.current,
			serialized: currentSerialized
		};
		pendingPushRef.current = pending;
		debounceTimeoutRef.current = window.setTimeout(() => {
			debounceTimeoutRef.current = null;
			const p = pendingPushRef.current;
			pendingPushRef.current = null;
			if (p === null) return;
			void doPushRef.current(p);
		}, CANVAS_SYNC_DEBOUNCE_MS);
	}, [enabled, syncStatus, currentSerialized, hydrated]);

	// ─── Flush pré-unmount + fermeture d'onglet ──────────────────────────
	// Objectif : ne PAS perdre un changement en attente au unmount du canvas
	// (navigation SPA) ni à la fermeture d'onglet. On registre 3 events pour
	// couvrir tous les cas :
	//   - `visibilitychange` (hidden) : couvre mobile + tab background — les
	//     browsers throttle voire droppent `beforeunload` en background tab.
	//   - `pagehide` : le seul event fiable côté mobile (iOS Safari surtout).
	//   - `beforeunload` : fallback desktop pour la fermeture directe.
	//
	// Chaque event peut fire plusieurs fois (ex. tab caché puis fermé) : on
	// idempotise en clearant pendingPushRef au premier flush.
	//
	// ─── Trade-off keepalive quota ───────────────────────────────────────
	// `fetch({ keepalive: true })` a un quota HTML de 64 KiB total en vol
	// par origin. Au-delà, le browser drop silencieusement. Pour les
	// payloads > 60 KB on fallback sur navigator.sendBeacon (limite similaire
	// mais implem browser-dépendante — best-effort) ; si absent, on log un
	// warn dev. Le happy path (débounce 2 s + fermeture normale) reste
	// safe : le PUT régulier part bien avant la fermeture.
	//
	// ─── Choix fetch vs sendBeacon ───────────────────────────────────────
	// sendBeacon n'accepte que POST. Notre backend attend PUT sur
	// `/api/canvas-state`. `fetch` avec `keepalive` reste donc le chemin
	// primaire — sendBeacon n'est utilisé qu'en dernier recours pour les
	// payloads géants où la fetch keepalive serait silencieusement droppée.
	useEffect(() => {
		function flushPending(): void {
			const pending = pendingPushRef.current;
			if (pending === null) return;
			if (debounceTimeoutRef.current !== null) {
				window.clearTimeout(debounceTimeoutRef.current);
				debounceTimeoutRef.current = null;
			}
			pendingPushRef.current = null;
			try {
				const body = JSON.stringify({
					signature: pending.signature,
					payload: JSON.parse(pending.serialized) as Record<string, unknown>
				});
				const url = `${window.CONTEXT.apiBaseUrl}/api/canvas-state`;

				if (body.length < KEEPALIVE_MAX_BODY_BYTES) {
					// `keepalive:true` = la request continue même si le document
					// est en train de disparaître. On ne peut pas awaiter le
					// résultat (l'onglet ferme) — on catch pour ne pas leak.
					fetch(url, {
						method: "PUT",
						credentials: "include",
						headers: { "Content-Type": "application/json" },
						body,
						keepalive: true
					}).catch(() => {
						// Silencieux : rien à faire, l'onglet part.
					});
					return;
				}

				// Payload > seuil keepalive : tenter sendBeacon si dispo. Notre
				// backend attend PUT, sendBeacon force POST — la request
				// arrivera avec la mauvaise méthode et le serveur répondra en
				// erreur, mais côté client on a tenté quelque chose. On log
				// en warn pour signaler que la persistance n'est pas fiable
				// pour ce payload à la fermeture.
				if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
					try {
						const blob = new Blob([body], { type: "application/json" });
						navigator.sendBeacon(url, blob);
					} catch {
						// sendBeacon peut throw sur quota — no-op.
					}
				}
				if (
					typeof console !== "undefined" &&
					typeof console.warn === "function"
				) {
					console.warn(
						`[canvas-sync] payload ${body.length} bytes > keepalive quota ${KEEPALIVE_MAX_BODY_BYTES} — flush à la fermeture n'est pas garanti.`
					);
				}
			} catch {
				// window.CONTEXT indispo (SSR / tests bruts) → no-op.
			}
		}

		function onVisibilityChange(): void {
			if (document.visibilityState === "hidden") flushPending();
		}

		window.addEventListener("beforeunload", flushPending);
		window.addEventListener("pagehide", flushPending);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			flushPending();
			window.removeEventListener("beforeunload", flushPending);
			window.removeEventListener("pagehide", flushPending);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, []);

	// `ready` : true quand plus rien ne peut modifier le state canvas via
	// hydration server. Un anonyme est ready immédiatement (pas de query,
	// pas de bascule state possible). Un user loggé est ready dès que
	// `hydrated` passe à true — que le settle soit 200 (replaceAll appliqué),
	// 404 (baseline vide), erreur (offline, garde le local).
	const ready = !enabled || hydrated;
	return { syncStatus, lastSavedAt, ready };
}
