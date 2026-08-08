/**
 * Page `/team/:slug/pair` — finalise le pairing device flow lancé par le
 * CLI (`sqlnest connect`).
 *
 * ─── Flow user ────────────────────────────────────────────────────────
 *   1. L'user tape `sqlnest connect` dans son terminal. Le CLI affiche
 *      un code type `ABCD-1234` et une URL à visiter.
 *   2. L'user ouvre `sqlnest.app/team/:slug/pair` (auth-required) et
 *      saisit le code. La page poll `/pairings/:code/status` :
 *      - Si le CLI est INCONNU (nouveau pairing) → demande un nom court.
 *      - Si le CLI est DÉJÀ CONNU (fingerprint match, C.7) → cache le
 *        champ nom, propose "Approuver la reconnexion".
 *   3. Clique « Autoriser ». POST `/api/tunnels/pairings/:code/approve`.
 *   4. Le CLI en polling détecte l'approbation, finalise l'auth Ed25519.
 *
 * ─── Layout ───────────────────────────────────────────────────────────
 * Réutilise `GallerySidebar` — même sidebar que la gallery, `activeItem="pair"`
 * highlight le CTA « Nouveau canvas ». Form centré dans le main sous le
 * PageHead. Pas de sub-title (AI slop) — l'user vient du CLI, il sait ce
 * qu'il fait.
 */

import { TextInput } from "@mantine/core";
import { Button } from "@sqlnest/design-system";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type FormEvent, useEffect, useState } from "react";
import { DismissibleAlert } from "../auth/DismissibleAlert";
import { GallerySidebar } from "../gallery/GallerySidebar";
import { PageHead } from "../gallery/PageHead";
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

const reconnectBannerStyle: CSSProperties = {
	background: "var(--sqlnest-accent-soft)",
	border: "1px solid var(--sqlnest-accent)",
	borderRadius: 8,
	padding: "10px 12px",
	fontSize: 13,
	color: "var(--sqlnest-text-primary)"
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

export function PairPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const teamSlug = useCurrentTeamSlug();
	const [code, setCode] = useState("");
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
				const statusUrl = teamSlug
					? `${apiBase()}/api/teams/${encodeURIComponent(teamSlug)}/tunnels/pairings/${encodeURIComponent(normalized)}/status`
					: `${apiBase()}/api/tunnels/pairings/${encodeURIComponent(normalized)}/status`;
				const res = await fetch(statusUrl, {
					credentials: "include",
					signal: controller.signal
				});
				if (!res.ok) {
					setExistingConnection(null);
					return;
				}
				const body = (await res.json()) as StatusResponse;
				setExistingConnection(body.existingConnection);
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

	// Redirect immédiat vers la gallery au succès. Invalide `db-connections`
	// — sans ça, la gallery affiche le cache (staleTime 5s) et la nouvelle
	// card n'apparaît pas avant le prochain poll.
	useEffect(() => {
		if (!success) return;
		void queryClient.invalidateQueries({ queryKey: ["db-connections"] });
		if (teamSlug) {
			void navigate({ to: "/team/$teamSlug", params: { teamSlug } });
		} else {
			void navigate({ to: "/" });
		}
	}, [success, navigate, queryClient, teamSlug]);

	return (
		<div style={pageStyle}>
			<GallerySidebar teamSlug={teamSlug} />
			<main style={mainStyle}>
				<PageHead title="Nouveau canvas" />
				<div style={contentStyle}>
					<div style={formWrapperStyle}>
						{error && (
							<DismissibleAlert onDismiss={() => setError(null)}>
								{error}
							</DismissibleAlert>
						)}
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
							{existingConnection ? (
								<div
									style={reconnectBannerStyle}
									data-testid="reconnect-banner"
								>
									Ce CLI est déjà pairé à{" "}
									<strong>« {existingConnection.name} »</strong>.
								</div>
							) : (
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
							)}
							<Button type="submit" disabled={isSubmitting} data-testid="submit">
								{existingConnection ? "Approuver la reconnexion" : "Autoriser"}
							</Button>
						</form>
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
