/**
 * Page `/connect` — finalise le pairing device flow lancé par le CLI.
 *
 * ─── Flow user ────────────────────────────────────────────────────────
 *   1. L'user tape `sqlnest connect` dans son terminal. Le CLI affiche
 *      un code type `ABCD-1234` et une URL à visiter.
 *   2. L'user ouvre `sqlnest.app/connect` (auth-required) et saisit
 *      le code. La page poll `/pairings/:code/status` :
 *      - Si le CLI est INCONNU (nouveau pairing) → demande un nom court
 *        pour cette connexion (`prod`, `apollon`, `local`…).
 *      - Si le CLI est DÉJÀ CONNU (fingerprint match, C.7) → n'affiche
 *        PAS le champ nom. Titre "Reconnexion à `<name>`", bouton unique
 *        "Approuver la reconnexion". Le backend autofill le deviceName.
 *   3. Clique « Approuver ». POST `/api/tunnels/pairings/:code/approve`
 *      avec le cookie de session Better Auth.
 *   4. Le CLI en polling détecte l'approbation, finalise l'authentification
 *      Ed25519, sauvegarde le token de session tunnel dans
 *      `~/.sqlnest/config.toml`.
 *
 * ─── Rappel labels terses ─────────────────────────────────────────────
 * Pas de sub-messages « ce bouton fait X ». Action + le minimum nécessaire.
 */

import { TextInput } from "@mantine/core";
import { Button } from "@sqlnest/design-system";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type FormEvent, useEffect, useState } from "react";
import { DismissibleAlert } from "../auth/DismissibleAlert";
import { useCurrentTeamSlug } from "../teams/useCurrentTeam";

/** Lazy — évite de figer la valeur au module-load, ce qui casserait les
 *  tests qui installent `window.CONTEXT` après l'import. */
function apiBase(): string {
	return window.CONTEXT.apiBaseUrl;
}

/** Debounce du poll `/status` sur input du code. Assez court pour un
 *  feedback réactif, assez long pour ne pas spammer pendant la saisie. */
const STATUS_POLL_DEBOUNCE_MS = 350;

/** Longueur canonique d'un code après `normalizeCode` (`XXXX-XXXX` → 8). */
const CODE_CANONICAL_LEN = 8;

const containerStyle: CSSProperties = {
	maxWidth: 420,
	margin: "48px auto",
	padding: "0 20px"
};

const titleStyle: CSSProperties = {
	fontSize: 20,
	fontWeight: 600,
	color: "var(--sqlnest-text-primary)",
	margin: "0 0 6px"
};

const subtitleStyle: CSSProperties = {
	fontSize: 13,
	color: "var(--sqlnest-text-secondary)",
	margin: "0 0 20px"
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

export function ConnectPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const teamSlug = useCurrentTeamSlug();
	const [code, setCode] = useState("");
	const [deviceName, setDeviceName] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);
	// existingConnection résolu par le poll `/status` — quand présent,
	// l'UI cache le champ nom et propose "Approuver la reconnexion".
	const [existingConnection, setExistingConnection] =
		useState<StatusResponse["existingConnection"]>(null);

	// Poll `/status` quand le code est valide (canonique 8 chars). Debounce
	// pour ne pas taper l'endpoint à chaque frappe. Le status endpoint est
	// authenticated via cookie, donc renvoie `existingConnection` si le
	// fingerprint du CLI matche une db_connection du user courant.
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
				// Erreur réseau ou abort — reset pour repartir sur le flow "nouveau"
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
			// Reconnexion : deviceName omis (autofill backend avec le nom
			// existant). Nouveau pairing : deviceName saisi.
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

	// Redirect immédiat vers la gallery au succès. Invalide aussi
	// `db-connections` — sans ça, la gallery affiche le cache TanStack
	// existant (staleTime 5s) et la nouvelle card n'apparaît pas avant
	// le prochain poll. Le CLI continue son authenticate en parallèle ;
	// le refetch triggered par l'invalidation renverra la row fraîche.
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
		<div style={containerStyle}>
			<h1 style={titleStyle}>Connecter un device</h1>
			<p style={subtitleStyle}>
				Saisis le code affiché par ton terminal après{" "}
				<code>sqlnest connect</code>.
			</p>
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
				/>
				{existingConnection ? (
					<div style={reconnectBannerStyle} data-testid="reconnect-banner">
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
					{isSubmitting
						? "En cours…"
						: existingConnection
							? "Approuver la reconnexion"
							: "Autoriser"}
				</Button>
			</form>
		</div>
	);
}
