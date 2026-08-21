/**
 * WriteConfirmBar — surface de confirmation inline pour les writes non filtrés
 * détectés par le walker [[unfilteredWrites.ts]] (voir [[ADR-023]] Q2 = typing
 * du verbe INLINE, PAS modal bloquant).
 *
 * ─── Comportement ─────────────────────────────────────────────────────
 * L'user tape la chaîne exacte attendue (`REMOVE FROM users` etc.) — le
 * bouton "Exécuter" reste disabled tant que la saisie ne matche pas
 * (comparaison normalisée : trim + espaces collapsés + upper case). Escape
 * ou clic "Annuler" ferme la bar sans exécuter. `⌘⇧⏎` (E/5) court-circuite
 * ce flow via un run direct en transaction.
 *
 * ─── Pourquoi le typing du verbe (Q2d) ────────────────────────────────
 * - Anti-reflexe : impossible de cliquer 2× par erreur (`⌘⏎ → chip → ⌘⏎`
 *   trap Q2b), impossible de Enter-Enter sur un modal (Q2a), force à LIRE
 *   la cible avant confirmation.
 * - Pattern éprouvé GitHub/Stripe/AWS pour les actions destructives.
 * - Inline dans un TextInput sous l'éditeur (pas un Modal bloquant) préserve
 *   le flow CodeMirror — Escape rend le focus à l'éditeur.
 *
 * ─── Ce qui n'est PAS géré ici ────────────────────────────────────────
 * - Timeout 5s auto-cancel : géré côté parent (`ConsoleShellInner`) qui
 *   contrôle le state pending — la bar est stateless sur ce point.
 * - Reset onChange source : idem, parent recompute walker et set pending
 *   à null si findings vide ou déclenche un nouveau flow.
 * - Wrap transaction sur `⌘⇧⏎` : E/5, hors scope E/3.
 */

import { TextInput } from "@mantine/core";
import { Button } from "@sqlnest/design-system";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { PreviewResult } from "./preview";
import type { UnfilteredFinding } from "./unfilteredWrites";

export interface WriteConfirmBarProps {
	/** Findings collectés par `collectUnfilteredWrites(stmt)` sur la source
	 * courante. Le premier est celui à retaper — les suivants sont juste
	 * listés en aperçu (le user en tape UN, ça suffit à valider "j'ai vu"). */
	readonly findings: readonly UnfilteredFinding[];
	/** Appelé quand l'user a tapé la chaîne exacte + validé (Enter ou clic).
	 * Le parent lance alors le vrai runConsoleQuery. */
	readonly onConfirm: () => void;
	/** Appelé sur Escape / clic "Annuler" / expiration du timeout. Le parent
	 * reset le pending state et rend le focus à l'éditeur SNQL. */
	readonly onCancel: () => void;
	/** Durée avant auto-cancel en ms. Défaut 15000 (15s). Le countdown est
	 * affiché au-dessus des boutons pour que l'user sache combien de temps
	 * il lui reste. */
	readonly timeoutMs?: number;
	/** [ADR-023 E/4] Résultat du preview count fetché en parallèle. `null` =
	 * loading (juste après le trigger, le fetch n'est pas revenu). `ok` =
	 * count disponible + disclaimer optionnel D17. `unavailable` = affichage
	 * "aperçu indisponible" avec la raison (unsupported / timeout / erreur). */
	readonly preview?: PreviewResult | null;
}

/** Chaîne canonique à retaper — dérivée du finding via son verbe + target
 * (uppercase pour lisibilité "action destructive"). Choisir un format qui
 * matche l'intention du verbe SNQL surface : `remove` → `REMOVE FROM t`,
 * `update` → `UPDATE t`, `add` → `ADD INTO t`, `raw` → `RAW`. */
export function expectedFor(finding: UnfilteredFinding): string {
	switch (finding.kind) {
		case "unfiltered_delete":
			return `REMOVE FROM ${finding.target}`;
		case "unfiltered_update":
			return `UPDATE ${finding.target}`;
		case "bulk_copy_insert":
			return `ADD INTO ${finding.target}`;
		case "raw_opaque":
			return "RAW";
	}
}

/** Normalise pour comparaison tolérante aux espaces + case. On veut que
 * `remove from users` typé lower-case matche aussi bien que `REMOVE  FROM
 * users` avec double-espace — mais l'ORDRE et les tokens doivent être
 * exacts. */
function normalize(s: string): string {
	return s.trim().replace(/\s+/g, " ").toUpperCase();
}

function matches(value: string, expected: string): boolean {
	return normalize(value) === normalize(expected);
}

const barStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 8,
	padding: "10px 14px",
	background: "var(--sqlnest-surface)",
	borderTop: "2px solid var(--sqlnest-warning)",
	borderBottom: "1px solid var(--sqlnest-border-subtle)",
	color: "var(--sqlnest-text-primary)",
	fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
	flexShrink: 0
};

const rowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 10,
	flexWrap: "wrap"
};

const labelStyle: CSSProperties = {
	fontSize: 13,
	fontWeight: 500,
	color: "var(--sqlnest-warning)",
	whiteSpace: "nowrap"
};

const counterStyle: CSSProperties = {
	fontSize: 12,
	color: "var(--sqlnest-text-tertiary)",
	fontVariantNumeric: "tabular-nums"
};

const targetHintStyle: CSSProperties = {
	fontSize: 12,
	color: "var(--sqlnest-text-secondary)",
	fontFamily: "var(--mantine-font-family-monospace)"
};

const previewCountStyle: CSSProperties = {
	fontSize: 12,
	fontWeight: 600,
	color: "var(--sqlnest-text-primary)",
	fontVariantNumeric: "tabular-nums",
	whiteSpace: "nowrap"
};

const previewMutedStyle: CSSProperties = {
	fontSize: 12,
	color: "var(--sqlnest-text-tertiary)",
	whiteSpace: "nowrap",
	fontStyle: "italic"
};

const previewDisclaimerStyle: CSSProperties = {
	fontSize: 11,
	color: "var(--sqlnest-warning)",
	whiteSpace: "normal",
	marginTop: 2
};

const inputWrapStyle: CSSProperties = {
	flex: "1 1 260px",
	minWidth: 200
};

const buttonsStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 10,
	marginLeft: "auto"
};

const countdownStyle: CSSProperties = {
	fontSize: 11,
	color: "var(--sqlnest-text-tertiary)",
	fontVariantNumeric: "tabular-nums",
	whiteSpace: "nowrap"
};

const countdownWarningStyle: CSSProperties = {
	...countdownStyle,
	color: "var(--sqlnest-warning)"
};

const listStyle: CSSProperties = {
	fontSize: 11,
	color: "var(--sqlnest-text-tertiary)",
	fontFamily: "var(--mantine-font-family-monospace)",
	lineHeight: 1.6
};

/** Formate un count avec séparateur milliers style français (`47 293` pas
 * `47,293`) — cohérent avec le reste de l'UI SQLNest français. */
function formatCount(n: number): string {
	return n.toLocaleString("fr-FR").replace(/ /g, " ");
}

/** Rend le badge preview selon l'état du fetch. Ne consomme pas d'espace
 * quand `undefined` (bar rendered sans avoir eu le temps de trigger le
 * fetch — cas rare). */
function renderPreviewBadge(
	preview: PreviewResult | null | undefined
): React.ReactNode {
	if (preview === undefined) return null;
	if (preview === null) {
		return (
			<span
				style={previewMutedStyle}
				data-testid="write-confirm-preview-loading"
			>
				Estimation…
			</span>
		);
	}
	if (preview.status === "ok") {
		return (
			<span
				style={previewCountStyle}
				data-testid="write-confirm-preview-count"
			>
				≈ {formatCount(preview.estimatedRowCount)}{" "}
				{preview.estimatedRowCount === 1 ? "ligne" : "lignes"}
			</span>
		);
	}
	// unavailable — un seul label muted quel que soit `reason`. Un dev
	// power-user peut inspecter reason via devtools si besoin ; l'user
	// normal veut juste savoir que l'estimation n'est pas dispo.
	const label =
		preview.reason === "timeout"
			? "Estimation indisponible (timeout)"
			: "Estimation indisponible";
	return (
		<span style={previewMutedStyle} data-testid="write-confirm-preview-unavailable">
			{label}
		</span>
	);
}

/** Label court affiché à gauche de la bar — l'user comprend d'un coup d'œil
 * QUOI il confirme, sans avoir à lire un pavé (feedback-no-ai-slop-labels). */
function shortLabel(finding: UnfilteredFinding): string {
	switch (finding.kind) {
		case "unfiltered_delete":
			return `Confirmer suppression de toutes les lignes de ${finding.target}`;
		case "unfiltered_update":
			return `Confirmer update de toutes les lignes de ${finding.target}`;
		case "bulk_copy_insert":
			return `Confirmer copie massive vers ${finding.target}`;
		case "raw_opaque":
			return "Confirmer requête raw (non analysable)";
	}
}

export function WriteConfirmBar({
	findings,
	onConfirm,
	onCancel,
	timeoutMs = 15000,
	preview
}: WriteConfirmBarProps): React.ReactNode {
	const [value, setValue] = useState("");
	const [remainingMs, setRemainingMs] = useState(timeoutMs);
	const inputRef = useRef<HTMLInputElement>(null);
	// onCancel stable via ref pour ne pas relancer le timer countdown à chaque
	// re-render du parent (il change à chaque render si non memoisé — le
	// countdown redémarrerait sans arrêt).
	const onCancelRef = useRef(onCancel);
	onCancelRef.current = onCancel;

	// L'user vient de hit "Exécuter" ou ⌘⏎ — on veut que le curseur atterrisse
	// immédiatement dans le TextInput sans qu'il ait à cliquer. autoFocus prop
	// suffit pour le premier mount, mais on ne peut pas la garantir cross-tab
	// (Mantine ne réappelle pas focus si la prop ne change pas). Un useEffect
	// explicite est plus robuste — force le focus quand le finding change.
	const firstOffset = findings[0]?.span.start.offset;
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => {
		inputRef.current?.focus();
	}, [firstOffset]);

	// [ADR-023 E/3.5] Countdown local — 250ms tick pour rendu smooth, appelle
	// onCancel automatiquement quand la deadline est atteinte. Re-init si le
	// finding change (nouveau pending). Cleanup obligatoire sinon leak.
	useEffect(() => {
		setRemainingMs(timeoutMs);
		const deadline = performance.now() + timeoutMs;
		const tick = setInterval(() => {
			const left = deadline - performance.now();
			if (left <= 0) {
				clearInterval(tick);
				setRemainingMs(0);
				onCancelRef.current();
				return;
			}
			setRemainingMs(left);
		}, 250);
		return () => clearInterval(tick);
	}, [firstOffset, timeoutMs]);

	if (findings.length === 0) return null;
	const first = findings[0];
	if (!first) return null;
	const expected = expectedFor(first);
	const canConfirm = matches(value, expected);

	function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
		if (e.key === "Escape") {
			e.preventDefault();
			onCancel();
			return;
		}
		if (e.key === "Enter" && canConfirm) {
			e.preventDefault();
			onConfirm();
			return;
		}
	}

	return (
		<div style={barStyle} role="alertdialog" aria-label="Confirmer l'écriture non filtrée">
			<div style={rowStyle}>
				<span style={labelStyle}>{shortLabel(first)}</span>
				{findings.length > 1 ? (
					<span style={counterStyle}>(1/{findings.length})</span>
				) : null}
				{renderPreviewBadge(preview)}
				<span style={targetHintStyle}>Retapez : {expected}</span>
				<div style={inputWrapStyle}>
					<TextInput
						ref={inputRef}
						value={value}
						onChange={(e) => setValue(e.currentTarget.value)}
						onKeyDown={handleKeyDown}
						placeholder={expected}
						autoComplete="off"
						spellCheck={false}
						data-testid="write-confirm-input"
						styles={{
							input: {
								fontFamily: "var(--mantine-font-family-monospace)",
								textTransform: "uppercase",
								letterSpacing: "0.03em"
							}
						}}
					/>
				</div>
				<div style={buttonsStyle}>
					<span
						style={remainingMs < 5000 ? countdownWarningStyle : countdownStyle}
						data-testid="write-confirm-countdown"
					>
						Expire dans {Math.max(0, Math.ceil(remainingMs / 1000))}s
					</span>
					<Button
						variant="secondary"
						onClick={onCancel}
						data-testid="write-confirm-cancel"
					>
						Annuler
					</Button>
					<Button
						onClick={onConfirm}
						disabled={!canConfirm}
						data-testid="write-confirm-submit"
					>
						Exécuter
					</Button>
				</div>
			</div>
			{preview?.status === "ok" && preview.disclaimer !== undefined ? (
				<div
					style={previewDisclaimerStyle}
					data-testid="write-confirm-preview-disclaimer"
				>
					⚠ {preview.disclaimer}
				</div>
			) : null}
			{findings.length > 1 ? (
				<div style={listStyle} data-testid="write-confirm-findings">
					{findings.map((f, i) => (
						<div key={`${f.span.start.offset}-${i}`}>
							{i + 1}. {expectedFor(f)}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
