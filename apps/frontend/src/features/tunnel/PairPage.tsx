/**
 * Page `/team/:slug/pair` — finalise le pairing device flow lancé par le
 * CLI (`sqlnest connect`).
 *
 * Flow user :
 *   1. `sqlnest connect` → CLI ouvre `/pair?code=ABCD-1234` (prefill).
 *   2. Le code est déjà dans l'input → debounce 350 ms → GET `/status`
 *      surface `existingConnection` (cascade fp/checksum) :
 *      - **Premier pairing** (`existingConnection == null`) — titre
 *        « Nouveau canvas », input Code + input Nom + bouton « Autoriser ».
 *      - **Reconnaissance** (`existingConnection != null`) — titre
 *        « Reconnexion à <name> », code preview verrouillé (ancre
 *        anti-phishing), bouton « Confirmer & ouvrir <name> ».
 *   3. Banner identité au-dessus du form : rappelle quel user va
 *      approuver l'attach du CLI à la db_connection.
 *   4. Click Confirmer → refetch session puis, en reconnaissance, re-poll
 *      `/status` (mitigation stale fp post `docker down/up`). POST
 *      `/approve` → `setSuccess`.
 *   5. Poll `/db-connections` jusqu'à trouver l'entry cible + isOnline,
 *      prefetch canvas data, navigate direct au canvas.
 */

import { Loader, TextInput } from "@mantine/core";
import { Button } from "@sqlnest/design-system";
import { IconArtboard, IconRefresh } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type FormEvent, useEffect, useState } from "react";
import { Route as PairRoute } from "../../routes/_authenticated.team.$teamSlug.pair";
import { DismissibleAlert } from "../auth/DismissibleAlert";
import { sessionQueryOptions, useCurrentUser } from "../auth/sessionQuery";
import { fetchDbConnections } from "../db-connections/useDbConnections";
import { GallerySidebar } from "../gallery/GallerySidebar";
import { PageHead } from "../gallery/PageHead";
import { prefetchCanvasData } from "../gallery/useNavigateToCanvas";
import { notifyInfo, notifySuccess } from "../notifications/notify";
import { useCurrentTeamSlug } from "../teams/useCurrentTeam";

function apiBase(): string {
	return window.CONTEXT.apiBaseUrl;
}

const STATUS_POLL_DEBOUNCE_MS = 350;
const CODE_CANONICAL_LEN = 8;

const pageStyle: CSSProperties = {
	display: "flex",
	minHeight: "100vh",
	background: "var(--sqlnest-surface)",
	color: "var(--sqlnest-text-primary)",
	fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif"
};

const mainStyle: CSSProperties = {
	flex: 1,
	display: "flex",
	flexDirection: "column",
	minWidth: 0
};

const contentStyle: CSSProperties = {
	flex: 1,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	padding: "48px 32px"
};

const formWrapperStyle: CSSProperties = {
	width: "100%",
	maxWidth: 380,
	display: "flex",
	flexDirection: "column",
	gap: 20
};

const formStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 14
};

const identityBannerStyle: CSSProperties = {
	background: "var(--sqlnest-surface-hover)",
	border: "1px solid var(--sqlnest-border)",
	borderRadius: 8,
	padding: "10px 12px",
	fontSize: 13,
	color: "var(--sqlnest-text-secondary)"
};

const helpStyle: CSSProperties = {
	fontSize: 12,
	color: "var(--sqlnest-text-tertiary)",
	textAlign: "center",
	lineHeight: 1.6
};

const codeChipStyle: CSSProperties = {
	background: "var(--sqlnest-surface-hover)",
	padding: "2px 6px",
	borderRadius: 4,
	fontSize: 12,
	fontFamily: "var(--mantine-font-family-monospace)",
	color: "var(--sqlnest-text-secondary)"
};

// Illustration au-dessus du form, différenciée selon le variant (premier
// vs reconnaissance). Rend visible la cascade silencieuse côté frontend :
// `IconRefresh` sur reconnaissance = signal fort « on retrouve ta DB »,
// complément du titre `PageHead`.
const heroIconStyle: CSSProperties = {
	display: "flex",
	justifyContent: "center",
	color: "var(--sqlnest-text-tertiary)"
};

const heroIconReconnectStyle: CSSProperties = {
	...heroIconStyle,
	color: "var(--sqlnest-accent)"
};

// En reconnaissance, le code Crockford reste l'ancre anti-phishing du
// device flow. On l'affiche en gros, verrouillé (pas de TextInput
// éditable), pour que l'user vérifie visuellement qu'il matche celui
// affiché dans son terminal AVANT de confirmer.
const codePreviewLabelStyle: CSSProperties = {
	fontSize: 11,
	fontWeight: 500,
	color: "var(--sqlnest-text-tertiary)",
	textTransform: "uppercase",
	letterSpacing: "0.05em"
};

const codePreviewValueStyle: CSSProperties = {
	fontFamily: "var(--mantine-font-family-monospace)",
	fontSize: 22,
	fontWeight: 600,
	letterSpacing: "0.15em",
	color: "var(--sqlnest-text-primary)",
	padding: "10px 14px",
	background: "var(--sqlnest-surface-hover)",
	border: "1px solid var(--sqlnest-border)",
	borderRadius: 8,
	textAlign: "center"
};

// Rendu post-approve pendant que le CLI finit /authenticate (1-3s).
// L'affichage doit rester visible sinon l'user voit une page vide entre
// le click "Autoriser" et l'arrivée sur le canvas.
const waitingStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	gap: 12,
	padding: "24px 0",
	fontSize: 13,
	color: "var(--sqlnest-text-secondary)"
};

/** Timeout local avant fallback gallery — au-delà, on assume que le CLI
 *  a un problème (browser resté ouvert, docker down, WSS bloqué) et on
 *  laisse l'user récupérer via la gallery plutôt que de tourner en rond
 *  sur un skeleton. */
const TUNNEL_POLL_TIMEOUT_MS = 15_000;

/** Cadence du poll pour trouver la db_connection créée à /authenticate.
 *  500 ms — sensible sans marteler ; le CLI met typiquement 1-3s à finir
 *  son handshake donc on a 2-6 polls avant de trouver. */
const TUNNEL_POLL_INTERVAL_MS = 500;

/** Normalise l'input code — strip espaces/dash, upper-case, remap
 *  Crockford confusables (I/L→1, O→0, U→V). Aligné sur
 *  `normalizePairingCode` du backend/CLI. */
function normalizeCode(raw: string): string {
	const stripped = raw.replace(/[\s-]/g, "").toUpperCase();
	const remap: Record<string, string> = { I: "1", L: "1", O: "0", U: "V" };
	let out = "";
	for (const ch of stripped) out += remap[ch] ?? ch;
	return out;
}

interface StatusResponse {
	readonly status: "pending" | "approved" | "expired" | "consumed";
	readonly deviceName: string | null;
	readonly existingConnection: {
		readonly id: string;
		readonly name: string;
	} | null;
}

/** Fetch `/status` — utilisé par le debounce initial ET par le re-poll
 *  D3 pré-approve (mitigation stale fp post `docker down/up`). Retourne
 *  `null` sur non-OK / abort — le caller gère le cas fallback. */
async function fetchPairingStatus(
	teamSlug: string | null,
	canonicalCode: string,
	signal?: AbortSignal
): Promise<StatusResponse | null> {
	const url = teamSlug
		? `${apiBase()}/api/teams/${encodeURIComponent(teamSlug)}/tunnels/pairings/${encodeURIComponent(canonicalCode)}/status`
		: `${apiBase()}/api/tunnels/pairings/${encodeURIComponent(canonicalCode)}/status`;
	const res = await fetch(url, { credentials: "include", signal });
	if (!res.ok) return null;
	return (await res.json()) as StatusResponse;
}

export function PairPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const teamSlug = useCurrentTeamSlug();
	// Le CLI ouvre `/pair?code=XXXX-XXXX` — on hydrate l'input avec cette
	// valeur. Le `useEffect` de debounce `/status` en bas se déclenche
	// automatiquement dès que `normalize(code).length === 8`.
	const { code: prefilledCode } = PairRoute.useSearch();
	const { data: session } = useCurrentUser();
	const [code, setCode] = useState(prefilledCode ?? "");
	const [deviceName, setDeviceName] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);
	const [existingConnection, setExistingConnection] =
		useState<StatusResponse["existingConnection"]>(null);

	useEffect(() => {
		const normalized = normalizeCode(code);
		if (normalized.length !== CODE_CANONICAL_LEN) {
			setExistingConnection(null);
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			try {
				const body = await fetchPairingStatus(
					teamSlug,
					normalized,
					controller.signal
				);
				setExistingConnection(body?.existingConnection ?? null);
			} catch {
				setExistingConnection(null);
			}
		}, STATUS_POLL_DEBOUNCE_MS);
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [code, teamSlug]);

	async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
		e.preventDefault();
		setError(null);
		const normalized = normalizeCode(code);
		if (normalized.length === 0) {
			setError("Code requis");
			return;
		}
		if (existingConnection == null && deviceName.trim().length === 0) {
			setError("Nom requis");
			return;
		}
		setIsSubmitting(true);
		try {
			// Refetch la session AU SUBMIT — la page peut être restée
			// ouverte plus longtemps que le cookie Better Auth (approve
			// attache un CLI à une db_connection team-scoped, effet
			// persistant ; on ne doit pas approuver avec un cookie mort).
			// Sur `data === null`, redirect vers login avec `?redirect=`
			// pointant sur ce même /pair — même contrat que le guard
			// `_authenticated.tsx:34-38`. LoginPage relit ce paramètre.
			const sessionData = await queryClient.fetchQuery(sessionQueryOptions());
			if (sessionData === null) {
				const returnPath = teamSlug
					? `/team/${encodeURIComponent(teamSlug)}/pair?code=${encodeURIComponent(normalized)}`
					: `/pair?code=${encodeURIComponent(normalized)}`;
				void navigate({ to: "/login", search: { redirect: returnPath } });
				return;
			}
			// En mode reconnaissance, re-poll `/status` juste avant
			// l'approve. Si l'user a fait `docker-compose down && up` entre
			// le mount et le click, le `system_identifier` PG a changé →
			// nouveau `db_fingerprint` → la cascade backend ne match plus,
			// l'user allait "reconnecter" à une db_connection stale. On
			// downgrade transparent vers le flow premier pairing (l'input
			// deviceName apparaît) sans surprise sécurité.
			if (existingConnection !== null) {
				const fresh = await fetchPairingStatus(teamSlug, normalized);
				if (fresh?.existingConnection == null) {
					setExistingConnection(null);
					setError(
						"La DB a changé côté CLI — indique un nom pour la nouvelle connexion."
					);
					return;
				}
			}
			const body =
				existingConnection == null ? { deviceName: deviceName.trim() } : {};
			const approveUrl = teamSlug
				? `${apiBase()}/api/teams/${encodeURIComponent(teamSlug)}/tunnels/pairings/${encodeURIComponent(normalized)}/approve`
				: `${apiBase()}/api/tunnels/pairings/${encodeURIComponent(normalized)}/approve`;
			const res = await fetch(approveUrl, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body)
			});
			const resBody = (await res.json().catch(() => ({}))) as {
				message?: string;
			};
			if (!res.ok) {
				setError(resBody.message ?? `Erreur HTTP ${res.status}`);
				return;
			}
			setSuccess(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Erreur réseau");
		} finally {
			setIsSubmitting(false);
		}
	}

	// Post-approve on va DIRECT au canvas de la db_connection pair-ée,
	// plus vers la gallery. On unifie premier pairing et reconnaissance
	// derrière un même poll :
	//
	//   1. Poll `/db-connections` jusqu'à trouver l'entry cible
	//      (par id si la cascade fp/checksum a matché, sinon par nom)
	//      ET `isOnline === true`. Cette double condition évite d'atterrir
	//      sur un canvas noir : le CLI doit avoir fini son /authenticate
	//      (row existe) ET être présent dans le registry WSS backend
	//      (`isOnline`) pour que `useSchema` réussisse au mount.
	//   2. Prefetch schema + layout + canvas_state (même pattern que
	//      `useNavigateToCanvas`). Sans ça, `useSchema` fetch au mount
	//      pendant que l'user voit un fond canvas vide 1-3s.
	//   3. Toast + navigate.
	//
	// Timeout `TUNNEL_POLL_TIMEOUT_MS` → fallback gallery (Q5b) : évite
	// de bloquer l'user si le CLI est mort (docker down, WSS bloqué).
	useEffect(() => {
		if (!success) return;
		const targetName = existingConnection?.name ?? deviceName.trim();
		const targetIdFromCascade = existingConnection?.id ?? null;
		const isReconnect = targetIdFromCascade !== null;
		void queryClient.invalidateQueries({ queryKey: ["db-connections"] });

		let cancelled = false;
		const deadlineMs = Date.now() + TUNNEL_POLL_TIMEOUT_MS;

		(async () => {
			let target: { id: string; name: string } | undefined;
			while (!cancelled && Date.now() < deadlineMs) {
				try {
					const list = await fetchDbConnections(teamSlug);
					target = targetIdFromCascade
						? list.find((c) => c.id === targetIdFromCascade && c.isOnline)
						: list.find((c) => c.name === targetName && c.isOnline);
					if (target) break;
				} catch {
					// Réseau intermittent — on retry au tick suivant.
				}
				await new Promise((r) => setTimeout(r, TUNNEL_POLL_INTERVAL_MS));
			}
			if (cancelled) return;

			if (!target || teamSlug === null) {
				notifyInfo(
					`Configuration en cours. \`${targetName}\` apparaîtra dans la gallery.`
				);
				if (teamSlug !== null) {
					void navigate({ to: "/team/$teamSlug", params: { teamSlug } });
				} else {
					void navigate({ to: "/" });
				}
				return;
			}

			try {
				await prefetchCanvasData(queryClient, teamSlug, target.id);
			} catch {
				// Prefetch KO → le canvas rendra son propre message d'erreur.
				// On navigate quand même pour ne pas piéger l'user sur /pair.
			}
			if (cancelled) return;
			notifySuccess(
				isReconnect
					? `Reconnecté à \`${target.name}\`.`
					: `Tunnel prêt : \`${target.name}\`.`
			);
			void navigate({
				to: "/team/$teamSlug/canvas/$connId",
				params: { teamSlug, connId: target.id }
			});
		})();

		return () => {
			cancelled = true;
		};
	}, [
		success,
		existingConnection,
		deviceName,
		teamSlug,
		navigate,
		queryClient
	]);

	return (
		<div style={pageStyle}>
			<GallerySidebar teamSlug={teamSlug} />
			<main style={mainStyle}>
				<PageHead
					title={
						existingConnection && !success
							? `Reconnexion à ${existingConnection.name}`
							: "Nouveau canvas"
					}
				/>
				<div style={contentStyle}>
					<div style={formWrapperStyle}>
						{error && !success && (
							<DismissibleAlert onDismiss={() => setError(null)}>
								{error}
							</DismissibleAlert>
						)}
						{!success &&
							(existingConnection ? (
								<div
									style={heroIconReconnectStyle}
									data-testid="hero-icon-reconnect"
								>
									<IconRefresh size={40} stroke={1.5} aria-hidden />
								</div>
							) : (
								<div style={heroIconStyle} data-testid="hero-icon-first">
									<IconArtboard size={40} stroke={1.5} aria-hidden />
								</div>
							))}
						{session?.user?.email && !success && (
							<div style={identityBannerStyle} data-testid="identity-banner">
								Connecté comme <strong>{session.user.email}</strong>. Autoriser
								ce CLI ?
							</div>
						)}
						{success ? (
							<div style={waitingStyle} data-testid="waiting-tunnel">
								<Loader size="sm" />
								<div>
									Configuration du tunnel —{" "}
									<strong>
										{existingConnection?.name ?? deviceName.trim()}
									</strong>
									…
								</div>
							</div>
						) : existingConnection ? (
							<form onSubmit={handleSubmit} style={formStyle}>
								<div>
									<div style={codePreviewLabelStyle}>Code du CLI</div>
									<div style={codePreviewValueStyle} data-testid="code-preview">
										{code}
									</div>
								</div>
								<Button
									type="submit"
									disabled={isSubmitting}
									data-testid="submit"
								>
									{`Confirmer & ouvrir ${existingConnection.name}`}
								</Button>
							</form>
						) : (
							<form onSubmit={handleSubmit} style={formStyle}>
								<TextInput
									label="Code"
									placeholder="ABCD-1234"
									value={code}
									onChange={(e) => setCode(e.currentTarget.value)}
									autoComplete="off"
									autoFocus
									required
									disabled={isSubmitting}
									data-testid="code-input"
									styles={{
										input: {
											fontFamily: "var(--mantine-font-family-monospace)",
											textTransform: "uppercase",
											letterSpacing: "0.05em"
										}
									}}
								/>
								<TextInput
									label="Nom"
									placeholder="Nom de la connexion"
									value={deviceName}
									onChange={(e) => setDeviceName(e.currentTarget.value)}
									autoComplete="off"
									required
									disabled={isSubmitting}
									data-testid="name-input"
								/>
								<Button
									type="submit"
									disabled={isSubmitting}
									data-testid="submit"
								>
									Autoriser
								</Button>
							</form>
						)}
						<div style={helpStyle}>
							Lance <code style={codeChipStyle}>sqlnest connect</code> dans ton
							terminal pour obtenir un code.
						</div>
					</div>
				</div>
			</main>
		</div>
	);
}
