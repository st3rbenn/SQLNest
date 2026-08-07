/**
 * Routes WSS pour le tunnel — le relais bête.
 *
 * ─── Endpoints ────────────────────────────────────────────────────────
 *   WSS  /api/tunnels/:sessionId/cli?token=tn_...
 *     Le CLI ouvre son socket. `token` est le `tn_<hex>` retourné à
 *     `/tunnels/authenticate`. Le path `:sessionId` doit matcher
 *     `session.id` du token (protection contre le mismatch).
 *
 *   WSS  /api/tunnels/by-connection/:connectionId/browser
 *     Le browser ouvre son socket (auth cookie). Le tunnel actif pour
 *     `(user_id, connection_id)` est cherché dans le registry — 404 si
 *     le CLI n'est pas connecté (l'user doit démarrer `sqlnest connect`
 *     d'abord).
 *
 * ─── Relais bête ──────────────────────────────────────────────────────
 * Le backend ne parse JAMAIS le payload. Il fait juste :
 *   - CLI → Browser(s) : broadcast à tous les browsers du slot.
 *   - Browser → CLI    : forward au CLI unique.
 * Les frames sont opaques (MessagePack signé + éventuellement AEAD-
 * chiffré). Le protocole `@sqlnest/tunnel-protocol` définit le contenu.
 *
 * ─── Codes de fermeture ───────────────────────────────────────────────
 *   4001 : replaced by newer CLI session (single-active).
 *   4003 : auth invalide (token ou session mismatch).
 *   4004 : no active tunnel (browser tente d'ouvrir sans CLI connecté).
 *   4006 : cross-user leak attempt (safeguard defense-in-depth).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { WebSocket } from "ws";
import z from "zod/v4";
import { requireUser } from "../../../domains/auth/require";
import { authenticateTunnelSession } from "../../../domains/tunnels/session/authenticate-tunnel-session";
import type { RegistrySocket } from "../../../domains/tunnels/session/registry";

const CliParams = z.object({ sessionId: z.string() });
const CliQuery = z.object({ token: z.string() });
const BrowserParams = z.object({
	connectionId: z.uuid("`connectionId` doit être un uuid")
});

/** Codes WS 4xxx application-defined. */
const CLOSE_AUTH_INVALID = 4003;
const CLOSE_NO_ACTIVE_TUNNEL = 4004;

/** Wrapper qui adapte un `WebSocket` (`ws`) au contrat `RegistrySocket`. */
function adapt(ws: WebSocket): RegistrySocket {
	// UUID stable par socket — le registry en a besoin pour distinguer
	// "je déco l'ancien socket qui remplace" de "je déco mon propre
	// socket".
	const id = crypto.randomUUID();
	return {
		id,
		send: (bytes) => ws.send(bytes),
		close: (code, reason) => ws.close(code, reason)
	};
}

export default async function tunnelsWsRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	// ─── CLI socket ───────────────────────────────────────────────────
	instance.get(
		"/:sessionId/cli",
		{
			websocket: true,
			schema: {
				params: CliParams,
				querystring: CliQuery
			}
		},
		async (socket, req) => {
			const request = req as FastifyRequest<{
				Params: { sessionId: string };
				Querystring: { token: string };
			}>;

			// Auth : valider le tn_... contre la DB.
			const auth = await authenticateTunnelSession(
				fastify.db,
				request.query.token
			);
			if (auth == null) {
				socket.close(CLOSE_AUTH_INVALID, "invalid token");
				return;
			}
			// Le sessionId dans le path doit matcher le token (empêche un
			// attaquant qui aurait volé un tn_... d'ouvrir un WS pour un
			// tunnelId qui ne lui appartient pas).
			if (auth.sessionId !== request.params.sessionId) {
				socket.close(CLOSE_AUTH_INVALID, "session mismatch");
				return;
			}

			const wrapped = adapt(socket);
			fastify.tunnelRegistry.attachCli({
				tunnelId: auth.sessionId,
				userId: auth.userId,
				connectionId: auth.connectionId,
				cliFingerprint: auth.cliFingerprint,
				socket: wrapped
			});

			socket.on("message", (data) => {
				// Le WS peut livrer un Buffer ou un array de Buffers. On
				// normalise en Uint8Array avant relais.
				const bytes = normalizeMessage(data);
				fastify.tunnelRegistry.routeToBrowsersFromCli(auth.sessionId, bytes);
			});

			socket.on("close", () => {
				fastify.tunnelRegistry.detachCli(auth.sessionId, wrapped.id);
			});
		}
	);

	// ─── Browser socket ───────────────────────────────────────────────
	instance.get(
		"/by-connection/:connectionId/browser",
		{
			websocket: true,
			preHandler: [requireUser],
			schema: {
				params: BrowserParams
			}
		},
		async (socket, req) => {
			const request = req as FastifyRequest<{
				Params: { connectionId: string };
			}>;
			if (request.user == null) {
				socket.close(CLOSE_AUTH_INVALID, "unauthenticated");
				return;
			}

			const slot = fastify.tunnelRegistry.findByConnection(
				request.user.id,
				request.params.connectionId
			);
			if (!slot) {
				socket.close(
					CLOSE_NO_ACTIVE_TUNNEL,
					"no active CLI tunnel for this connection — start `sqlnest connect` first"
				);
				return;
			}

			const wrapped = adapt(socket);
			const res = fastify.tunnelRegistry.attachBrowser(
				slot.tunnelId,
				request.user.id,
				wrapped
			);
			if (!res.ok) {
				socket.close(CLOSE_AUTH_INVALID, res.reason);
				return;
			}

			socket.on("message", (data) => {
				const bytes = normalizeMessage(data);
				fastify.tunnelRegistry.routeToCliFromBrowser(slot.tunnelId, bytes);
			});

			socket.on("close", () => {
				fastify.tunnelRegistry.detachBrowser(slot.tunnelId, wrapped.id);
			});
		}
	);
}

/** `ws` peut livrer un Buffer, un `Buffer[]` (fragmentation) ou un
 *  ArrayBuffer. On aplatit vers un unique Uint8Array pour le registry. */
function normalizeMessage(raw: unknown): Uint8Array {
	if (raw instanceof Uint8Array) return raw;
	if (Array.isArray(raw)) {
		const total = raw.reduce(
			(acc: number, b: unknown) =>
				acc + (b instanceof Uint8Array ? b.length : 0),
			0
		);
		const out = new Uint8Array(total);
		let off = 0;
		for (const b of raw as Uint8Array[]) {
			out.set(b, off);
			off += b.length;
		}
		return out;
	}
	if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
	return new Uint8Array();
}
