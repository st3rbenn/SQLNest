/**
 * Panneau d'erreur SNQL affiché sous les résultats. Rend :
 *
 *  - Le message natif Postgres (sans la string composite `— SQLSTATE — hint`
 *    historique — chaque champ vit dans son propre chip).
 *  - Une liste de chips `$N = value` cliquables — chaque occurrence de
 *    `$N` dans le message est résolue en (a) sa valeur bindée via
 *    `pgError.params[N-1]` et (b) son span source SNQL via
 *    `pgError.paramSpans[N-1]`. Clic → `onFocusSpan(span)` remonte au
 *    parent qui commande l'éditeur (`SnqlEditorHandle.focusSpan`).
 *  - Chips secondaires : `SQLSTATE`, `column`, `constraint`, `detail`,
 *    `hint`, `position` — utiles pour diagnostiquer.
 *
 * Sans `pgError` : fallback au message string brut (erreurs transport,
 * 503 pas de tunnel, 500 interne, etc.).
 */

import type { CSSProperties } from "react";
import { useMemo } from "react";
import type { PgErrorInfo, SerializedSpan, SnqlRuntimeError } from "./useRunQuery";

const containerStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 8,
	padding: "10px 12px",
	background: "var(--sqlnest-surface-hover)",
	border: "1px solid var(--sqlnest-danger)",
	borderRadius: 6,
	color: "var(--sqlnest-text-primary)",
	fontSize: 12,
	lineHeight: 1.5
};

const messageStyle: CSSProperties = {
	color: "var(--sqlnest-danger)",
	fontWeight: 500,
	fontFamily: "var(--mantine-font-family-monospace)",
	whiteSpace: "pre-wrap",
	wordBreak: "break-word"
};

const chipRowStyle: CSSProperties = {
	display: "flex",
	flexWrap: "wrap",
	gap: 6,
	alignItems: "center"
};

const chipBaseStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 4,
	padding: "2px 6px",
	borderRadius: 4,
	background: "var(--sqlnest-surface)",
	border: "1px solid var(--sqlnest-border)",
	fontFamily: "var(--mantine-font-family-monospace)",
	fontSize: 11,
	color: "var(--sqlnest-text-secondary)"
};

const chipClickableStyle: CSSProperties = {
	...chipBaseStyle,
	cursor: "pointer",
	borderColor: "var(--sqlnest-accent-muted)",
	color: "var(--sqlnest-text-primary)",
	background: "var(--sqlnest-accent-soft)"
};

const chipLabelStyle: CSSProperties = {
	color: "var(--sqlnest-text-tertiary)",
	fontWeight: 500
};

const chipValueStyle: CSSProperties = {
	color: "var(--sqlnest-text-primary)",
	fontWeight: 600
};

const detailRowStyle: CSSProperties = {
	display: "flex",
	gap: 6,
	alignItems: "baseline",
	fontFamily: "var(--mantine-font-family-monospace)",
	fontSize: 11,
	color: "var(--sqlnest-text-secondary)"
};

const detailLabelStyle: CSSProperties = {
	color: "var(--sqlnest-text-tertiary)",
	fontWeight: 500,
	minWidth: 60
};

/** Match `$1`, `$42`, … dans le message pg. Capture le numéro (1-indexé). */
const PLACEHOLDER_RE = /\$(\d+)/g;

/**
 * Formatte une valeur bindée pour l'afficher dans un chip. Rend `null`, string,
 * number, boolean, bigint de façon compacte. Un objet inconnu est stringifié
 * en JSON tronqué — évite d'exploser la largeur.
 */
function formatValue(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") {
		const quoted = JSON.stringify(value);
		return quoted.length > 40 ? `${quoted.slice(0, 38)}…"` : quoted;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (typeof value === "bigint") return `${value.toString()}n`;
	try {
		const s = JSON.stringify(value);
		return s.length > 40 ? `${s.slice(0, 38)}…` : s;
	} catch {
		return String(value);
	}
}

interface ParamRef {
	readonly index: number; // 1-indexed
	readonly value: unknown;
	readonly span?: SerializedSpan;
}

/**
 * Rend un chip label/name — cliquable si `identSpans[name]` porte au moins
 * un span (Phase 3b-lite). Le clic focus le premier match ; on ne montre pas
 * un chip par match individuel pour ne pas polluer l'UI quand un ident
 * apparaît N fois.
 */
function renderIdentChip(
	label: string,
	name: string,
	identSpans: PgErrorInfo["identSpans"],
	onFocusSpan?: (span: SerializedSpan) => void
): React.ReactNode {
	const spans = identSpans?.[name];
	const firstSpan = spans?.[0];
	const clickable = firstSpan !== undefined && onFocusSpan !== undefined;
	if (!clickable) {
		return (
			<span style={chipBaseStyle}>
				<span style={chipLabelStyle}>{label}</span>
				<span style={chipValueStyle}>{name}</span>
			</span>
		);
	}
	const total = spans?.length ?? 0;
	return (
		<button
			type="button"
			style={chipClickableStyle}
			onClick={() => onFocusSpan?.(firstSpan)}
			title={
				total > 1
					? `Aller à la 1re des ${total} occurrences dans l'éditeur`
					: "Aller à l'occurrence dans l'éditeur"
			}
		>
			<span style={chipLabelStyle}>{label}</span>
			<span style={chipValueStyle}>{name}</span>
			{total > 1 ? <span style={chipLabelStyle}>×{total}</span> : null}
		</button>
	);
}

/**
 * Extrait les `$N` référencés dans le message pg, dédupliqués et triés dans
 * l'ordre de première apparition. Résout la valeur + span depuis `pgError`
 * (aligné positionnellement — `paramSpans[N-1]` correspond à `params[N-1]`).
 */
function extractParamRefs(pgError: PgErrorInfo): readonly ParamRef[] {
	const seen = new Map<number, ParamRef>();
	for (const match of pgError.message.matchAll(PLACEHOLDER_RE)) {
		const raw = match[1];
		if (raw === undefined) continue;
		const idx = Number.parseInt(raw, 10);
		if (!Number.isFinite(idx) || idx <= 0) continue;
		if (seen.has(idx)) continue;
		const value = pgError.params?.[idx - 1];
		const span = pgError.paramSpans?.[idx - 1];
		seen.set(idx, span !== undefined ? { index: idx, value, span } : { index: idx, value });
	}
	return Array.from(seen.values()).sort((a, b) => a.index - b.index);
}

export interface ErrorBlockProps {
	readonly error: SnqlRuntimeError | Error;
	readonly onFocusSpan?: ((span: SerializedSpan) => void) | undefined;
}

export function ErrorBlock({ error, onFocusSpan }: ErrorBlockProps): React.ReactNode {
	const pgError =
		error instanceof Error && "pgError" in error
			? (error as SnqlRuntimeError).pgError
			: undefined;

	const paramRefs = useMemo(
		() => (pgError !== undefined ? extractParamRefs(pgError) : []),
		[pgError]
	);

	// Sans pgError : rendu compact, juste le message brut (erreur transport).
	if (pgError === undefined) {
		return (
			<div style={containerStyle}>
				<div style={messageStyle}>{error.message}</div>
			</div>
		);
	}

	return (
		<div style={containerStyle}>
			<div style={messageStyle}>{pgError.message}</div>

			{paramRefs.length > 0 ? (
				<div style={chipRowStyle}>
					{paramRefs.map((ref) => {
						const clickable = ref.span !== undefined && onFocusSpan !== undefined;
						const style = clickable ? chipClickableStyle : chipBaseStyle;
						const onClick = clickable
							? () => {
									if (ref.span !== undefined) onFocusSpan?.(ref.span);
								}
							: undefined;
						const title = clickable
							? "Aller au token source dans l'éditeur"
							: ref.span === undefined
								? "Aucun span source disponible pour ce paramètre"
								: undefined;
						return (
							<button
								key={ref.index}
								type="button"
								style={{ ...style, border: style.border }}
								onClick={onClick}
								disabled={!clickable}
								title={title}
							>
								<span style={chipLabelStyle}>${ref.index}</span>
								<span>=</span>
								<span style={chipValueStyle}>{formatValue(ref.value)}</span>
							</button>
						);
					})}
				</div>
			) : null}

			<div style={chipRowStyle}>
				{pgError.code !== undefined ? (
					<span style={chipBaseStyle}>
						<span style={chipLabelStyle}>SQLSTATE</span>
						<span style={chipValueStyle}>{pgError.code}</span>
					</span>
				) : null}
				{pgError.column !== undefined
					? renderIdentChip("col", pgError.column, pgError.identSpans, onFocusSpan)
					: null}
				{pgError.table !== undefined
					? renderIdentChip("table", pgError.table, pgError.identSpans, onFocusSpan)
					: null}
				{pgError.constraint !== undefined ? (
					<span style={chipBaseStyle}>
						<span style={chipLabelStyle}>constraint</span>
						<span style={chipValueStyle}>{pgError.constraint}</span>
					</span>
				) : null}
				{pgError.position !== undefined ? (
					<span style={chipBaseStyle}>
						<span style={chipLabelStyle}>pos</span>
						<span style={chipValueStyle}>{pgError.position}</span>
					</span>
				) : null}
			</div>

			{pgError.detail !== undefined ? (
				<div style={detailRowStyle}>
					<span style={detailLabelStyle}>detail</span>
					<span>{pgError.detail}</span>
				</div>
			) : null}
			{pgError.hint !== undefined ? (
				<div style={detailRowStyle}>
					<span style={detailLabelStyle}>hint</span>
					<span>{pgError.hint}</span>
				</div>
			) : null}
		</div>
	);
}
