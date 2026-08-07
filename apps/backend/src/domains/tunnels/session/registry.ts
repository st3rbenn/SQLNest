/**
 * Registry in-memory des tunnels WS actifs — routing bête frame-by-frame
 * entre le CLI et le browser (ou N browsers pour un même tunnel).
 *
 * ─── Contrat ──────────────────────────────────────────────────────────
 * Le registry ne parse jamais les payloads. Il route par `tunnelId` +
 * `dir` (cli ↔ browser). Chaque slot :
 *   - `cli`     : 0 ou 1 socket (single-active — la nouvelle déco l'ancienne).
 *   - `browsers`: 0..N sockets (un user peut avoir plusieurs onglets sur
 *                 le même tunnel). Route CLI→browser broadcast à tous.
 *
 * ─── Cycle de vie ─────────────────────────────────────────────────────
 *   attachCli   : crée le slot si absent, remplace un ancien socket.
 *   detachCli   : ne DÉTRUIT PAS le slot — le browser peut être encore
 *                 attaché en attendant la reconnexion du CLI.
 *   attachBrowser : rejette si aucun CLI actif ou userId mismatch.
 *   detachBrowser : retire de la Set. Détruit le slot si vide (0 cli,
 *                   0 browser).
 *
 * ─── Sécurité ─────────────────────────────────────────────────────────
 * Toute frame routée est OPAQUE — le registry ne peut pas lire son
 * contenu. La couche route WSS valide juste que le socket qui envoie
 * la frame a le droit d'envoyer dans ce sens (dir=cli vient du socket
 * CLI, dir=browser d'un socket browser).
 */

export interface RegistrySocket {
	send(bytes: Uint8Array): void;
	close(code?: number, reason?: string): void;
	readonly id: string;
}

export interface TunnelSlot {
	readonly tunnelId: string;
	readonly userId: string;
	readonly connectionId: string;
	readonly cliFingerprint: string;
	cli: RegistrySocket | null;
	browsers: Map<string, RegistrySocket>;
}

export type AttachBrowserResult =
	| { ok: true }
	| { ok: false; reason: "tunnel_not_found" | "user_mismatch" };

export interface TunnelRegistry {
	attachCli(params: {
		tunnelId: string;
		userId: string;
		connectionId: string;
		cliFingerprint: string;
		socket: RegistrySocket;
	}): void;
	detachCli(tunnelId: string, socketId: string): void;
	attachBrowser(
		tunnelId: string,
		userId: string,
		socket: RegistrySocket
	): AttachBrowserResult;
	detachBrowser(tunnelId: string, socketId: string): void;
	routeToCliFromBrowser(tunnelId: string, bytes: Uint8Array): boolean;
	/** Envoie des bytes au CLI depuis un émetteur in-process (typiquement
	 *  le backend-proxy — voir `domains/tunnels/backend-proxy.ts`). Retourne
	 *  `false` si le CLI n'est pas attaché. */
	routeToCliFromBackend(tunnelId: string, bytes: Uint8Array): boolean;
	routeToBrowsersFromCli(tunnelId: string, bytes: Uint8Array): number; // nombre de browsers touchés
	/** Souscrit aux frames émises par le CLI d'un tunnel (in-process).
	 *  Retourne un unsubscribe. Utilisé par le backend-proxy pour recevoir
	 *  les frames `res` du CLI sans passer par un WS browser. Les
	 *  subscribers sont notifiés en PLUS des browsers attachés. */
	subscribeCliFrames(
		tunnelId: string,
		callback: (bytes: Uint8Array) => void
	): () => void;
	getSlot(tunnelId: string): TunnelSlot | undefined;
	/** Retrouve un slot actif par `(userId, connectionId)` — utilisé côté
	 *  browser qui connaît sa connection mais pas le tunnelId éphémère. */
	findByConnection(
		userId: string,
		connectionId: string
	): TunnelSlot | undefined;
	size(): number;
}

/** Codes de fermeture WebSocket 4xxx = application-defined. */
export const WS_CLOSE_REPLACED = 4001;

export function createTunnelRegistry(): TunnelRegistry {
	const slots = new Map<string, TunnelSlot>();
	/** In-process subscribers par tunnelId. Notifiés à chaque frame
	 *  reçue du CLI, en plus des browsers WS attachés. */
	const cliSubscribers = new Map<string, Set<(bytes: Uint8Array) => void>>();

	function ensureSlot(
		tunnelId: string,
		userId: string,
		connectionId: string,
		cliFingerprint: string
	): TunnelSlot {
		let slot = slots.get(tunnelId);
		if (!slot) {
			slot = {
				tunnelId,
				userId,
				connectionId,
				cliFingerprint,
				cli: null,
				browsers: new Map()
			};
			slots.set(tunnelId, slot);
		}
		return slot;
	}

	return {
		attachCli({ tunnelId, userId, connectionId, cliFingerprint, socket }) {
			const slot = ensureSlot(tunnelId, userId, connectionId, cliFingerprint);
			if (slot.cli && slot.cli.id !== socket.id) {
				slot.cli.close(WS_CLOSE_REPLACED, "replaced by newer CLI session");
			}
			slot.cli = socket;
		},

		detachCli(tunnelId, socketId) {
			const slot = slots.get(tunnelId);
			if (!slot) return;
			if (slot.cli && slot.cli.id === socketId) {
				slot.cli = null;
			}
			// Cleanup slot si complètement vide (pas de browser non plus).
			if (!slot.cli && slot.browsers.size === 0) {
				slots.delete(tunnelId);
			}
		},

		attachBrowser(tunnelId, userId, socket) {
			const slot = slots.get(tunnelId);
			if (!slot) return { ok: false, reason: "tunnel_not_found" };
			if (slot.userId !== userId) return { ok: false, reason: "user_mismatch" };
			slot.browsers.set(socket.id, socket);
			return { ok: true };
		},

		detachBrowser(tunnelId, socketId) {
			const slot = slots.get(tunnelId);
			if (!slot) return;
			slot.browsers.delete(socketId);
			if (!slot.cli && slot.browsers.size === 0) {
				slots.delete(tunnelId);
			}
		},

		routeToCliFromBrowser(tunnelId, bytes) {
			const slot = slots.get(tunnelId);
			if (!slot || !slot.cli) return false;
			slot.cli.send(bytes);
			return true;
		},

		routeToCliFromBackend(tunnelId, bytes) {
			const slot = slots.get(tunnelId);
			if (!slot || !slot.cli) return false;
			slot.cli.send(bytes);
			return true;
		},

		routeToBrowsersFromCli(tunnelId, bytes) {
			const slot = slots.get(tunnelId);
			if (!slot) return 0;
			let count = 0;
			for (const [, sock] of slot.browsers) {
				sock.send(bytes);
				count += 1;
			}
			// Notifie aussi les subscribers in-process (backend-proxy).
			const subs = cliSubscribers.get(tunnelId);
			if (subs) {
				for (const cb of subs) {
					try {
						cb(bytes);
					} catch {
						// Un subscriber qui throw ne casse pas le broadcast
						// aux browsers.
					}
				}
			}
			return count;
		},

		subscribeCliFrames(tunnelId, callback) {
			let set = cliSubscribers.get(tunnelId);
			if (!set) {
				set = new Set();
				cliSubscribers.set(tunnelId, set);
			}
			set.add(callback);
			return () => {
				const s = cliSubscribers.get(tunnelId);
				if (!s) return;
				s.delete(callback);
				if (s.size === 0) cliSubscribers.delete(tunnelId);
			};
		},

		getSlot(tunnelId) {
			return slots.get(tunnelId);
		},

		findByConnection(userId, connectionId) {
			for (const slot of slots.values()) {
				if (slot.userId === userId && slot.connectionId === connectionId) {
					return slot;
				}
			}
			return undefined;
		},

		size() {
			return slots.size;
		}
	};
}
