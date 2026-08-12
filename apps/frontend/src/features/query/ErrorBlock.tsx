/**
 * Bloc erreur structuré pour la console SNQL.
 *
 * Deux chemins de rendu selon ce que le CLI/backend remonte :
 *
 * - **Chemin riche (Phase 3a/b/c)** : le payload contient un `pgError` structuré
 *   ({message, code, position, detail, hint, column, table, constraint, params,
 *   paramSpans, rowSpans, identSpans}). On rend :
 *     - le message natif en monospace (identifiants et opérateurs comptent),
 *     - une ligne de chips `$N = value` cliquables — chaque occurrence de
 *       `$N` dans le message est résolue en la valeur bindée + le span source
 *       SNQL correspondant (paramSpans[N-1]). Clic → `onFocusSpan(span)`
 *       remonte au parent qui commande l'éditeur.
 *     - chips col/table cliquables via `identSpans` (résout `column "X" does
 *       not exist` → premier span source de X).
 *     - le hint sur une ligne à part avec pictogramme.
 *
 * - **Chemin fallback (rétro-compat)** : si `pgError` est absent (erreur
 *   transport, ou CLI encore sur l'ancien wire), on parse le message composite
 *   historique (`<msg> — SQLSTATE — hint:`, cf. `describePgExecutionError`) et
 *   on rend le même layout minus les chips résolues.
 *
 * Bouton copy : le texte brut (avant parse/structure) va au presse-papiers —
 * pour coller dans un ticket ou un chat, on veut la forme complète.
 */

import { showNotification } from "@sqlnest/design-system";
import { IconAlertCircle, IconBulb, IconCopy } from "@tabler/icons-react";
import type { CSSProperties } from "react";
import { useMemo } from "react";
import type {
	PgErrorInfo,
	SerializedSpan,
	SnqlRuntimeError
} from "./useRunQuery";

interface ErrorBlockProps {
	readonly error: Error;
	readonly onFocusSpan?: ((span: SerializedSpan) => void) | undefined;
}

const containerStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 8,
	padding: "12px 14px",
	background: "var(--sqlnest-danger-soft)",
	border: "1px solid var(--sqlnest-danger-border)",
	borderRadius: 6,
	minHeight: 0
};

const headerStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	color: "var(--sqlnest-danger)",
	fontSize: 12,
	fontWeight: 600
};

const badgeStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	padding: "1px 6px",
	fontSize: 10,
	fontWeight: 600,
	fontVariantNumeric: "tabular-nums",
	color: "var(--sqlnest-danger)",
	background: "var(--sqlnest-surface)",
	border: "1px solid var(--sqlnest-danger-border)",
	borderRadius: 4,
	letterSpacing: 0.2
};

const copyButtonStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 4,
	padding: "2px 6px",
	fontSize: 10.5,
	fontWeight: 500,
	color: "var(--sqlnest-text-secondary)",
	background: "transparent",
	border: "1px solid var(--sqlnest-border)",
	borderRadius: 4,
	cursor: "pointer"
};

const messageStyle: CSSProperties = {
	fontFamily: "var(--mantine-font-family-monospace)",
	fontSize: 12,
	lineHeight: 1.5,
	color: "var(--sqlnest-text-primary)",
	whiteSpace: "pre-wrap",
	wordBreak: "break-word"
};

const detailStyle: CSSProperties = {
	fontSize: 11.5,
	lineHeight: 1.5,
	color: "var(--sqlnest-text-secondary)",
	fontFamily: "var(--mantine-font-family-monospace)",
	whiteSpace: "pre-wrap",
	wordBreak: "break-word"
};

const hintRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "flex-start",
	gap: 6,
	fontSize: 11.5,
	lineHeight: 1.5,
	color: "var(--sqlnest-text-secondary)",
	paddingTop: 4,
	borderTop: "1px dashed var(--sqlnest-danger-border)"
};

const hintIconStyle: CSSProperties = {
	color: "var(--sqlnest-warning)",
	flexShrink: 0,
	marginTop: 2
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
	color: "var(--sqlnest-text-secondary)",
	cursor: "default"
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

export function ErrorBlock({ error, onFocusSpan }: ErrorBlockProps): React.ReactNode {
	const pgError =
		error instanceof Error && "pgError" in error
			? (error as SnqlRuntimeError).pgError
			: undefined;

	// Chemin riche : pgError structuré. Sinon fallback sur le parse composite
	// historique pour rétro-compat avec un CLI/backend non porté.
	const displayed = useMemo(() => {
		if (pgError !== undefined) return fromPgError(pgError);
		return parseErrorMessage(error.message);
	}, [pgError, error.message]);

	const paramRefs = useMemo(
		() => (pgError !== undefined ? extractParamRefs(pgError) : []),
		[pgError]
	);

	// Un ident référencé dans le message (`column "foo" does not exist`,
	// `relation "bar" does not exist`, `operator does not exist: "text" = "int"`)
	// est considéré résolu si `identSpans[name]` porte au moins un span valide.
	// Sert à décider si on affiche le fallback `pos <N>` (byte offset dans le
	// SQL généré, opaque à l'utilisateur qui ne le voit jamais).
	const hasResolvedIdent = useMemo(
		() =>
			pgError !== undefined &&
			(identMatchesInSpans(pgError.message, pgError.identSpans) ||
				identNameHasSpan(pgError.column, pgError.identSpans) ||
				identNameHasSpan(pgError.table, pgError.identSpans)),
		[pgError]
	);
	const hasResolvedContext = paramRefs.length > 0 || hasResolvedIdent;

	const copy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(error.message);
			showNotification({
				title: "Copié",
				message: "Message d'erreur dans le presse-papiers",
				color: "blue",
				autoClose: 1500
			});
		} catch {
			showNotification({
				title: "Copie impossible",
				message: "Le presse-papiers a refusé l'accès.",
				color: "red",
				autoClose: 2500
			});
		}
	};

	return (
		<div style={containerStyle} role="alert">
			<div style={headerStyle}>
				<IconAlertCircle size={14} stroke={2} />
				<span>Erreur</span>
				{displayed.sqlstate !== undefined ? (
					<span style={badgeStyle} title="SQLSTATE Postgres">
						{displayed.sqlstate}
					</span>
				) : null}
				{displayed.codeName !== undefined ? (
					<span style={badgeStyle} title="MongoDB codeName">
						{displayed.codeName}
					</span>
				) : null}
				<div style={{ flex: 1 }} />
				<button
					type="button"
					style={copyButtonStyle}
					onClick={copy}
					aria-label="Copier le message d'erreur"
				>
					<IconCopy size={11} stroke={2} />
					Copier
				</button>
			</div>

			<div style={messageStyle}>{displayed.message}</div>

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
								style={style}
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

			{pgError !== undefined &&
			(pgError.column !== undefined ||
				pgError.table !== undefined ||
				pgError.constraint !== undefined ||
				(pgError.position !== undefined && !hasResolvedContext)) ? (
				<div style={chipRowStyle}>
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
					{/* `pos N` = byte offset dans le SQL généré, 1-indexé. Opaque à
					    l'utilisateur qui ne voit jamais le SQL — on ne l'affiche que
					    quand rien d'autre n'a pu être résolu (fallback debug). Un
					    vrai source-map SQL→SNQL le rendrait cliquable — différé. */}
					{pgError.position !== undefined && !hasResolvedContext ? (
						<span
							style={chipBaseStyle}
							title="Offset dans le SQL généré (usage debug — pas de mapping vers le SNQL disponible)"
						>
							<span style={chipLabelStyle}>pos</span>
							<span style={chipValueStyle}>{pgError.position}</span>
						</span>
					) : null}
				</div>
			) : null}

			{displayed.details.map((detail, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: les segments detail
				// viennent d'un source déterministe — l'ordre est stable pour un message donné.
				<div key={i} style={detailStyle}>
					{detail}
				</div>
			))}

			{displayed.hint !== undefined ? (
				<div style={hintRowStyle}>
					<IconBulb size={13} stroke={2} style={hintIconStyle} />
					<span>{displayed.hint}</span>
				</div>
			) : null}
		</div>
	);
}

interface ParsedError {
	readonly message: string;
	readonly sqlstate?: string;
	readonly codeName?: string;
	readonly hint?: string;
	readonly details: readonly string[];
}

/** Match `$1`, `$42`, … dans le message pg. Capture le numéro (1-indexé). */
const PLACEHOLDER_RE = /\$(\d+)/g;

interface ParamRef {
	readonly index: number; // 1-indexed
	readonly value: unknown;
	readonly span?: SerializedSpan;
}

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
		const rawSpan = pgError.paramSpans?.[idx - 1];
		// Défensif : le span peut arriver null/mal-formé via msgpackr → skip.
		const span =
			Array.isArray(rawSpan) &&
			rawSpan.length === 2 &&
			typeof rawSpan[0] === "number" &&
			typeof rawSpan[1] === "number"
				? (rawSpan as SerializedSpan)
				: undefined;
		seen.set(
			idx,
			span !== undefined ? { index: idx, value, span } : { index: idx, value }
		);
	}
	return Array.from(seen.values()).sort((a, b) => a.index - b.index);
}

/**
 * Vérifie qu'un nom d'ident a au moins un span valide dans `identSpans`.
 * Rejette un `spans` non-array, un tuple mal formé, ou une entrée manquante.
 * Utilisé pour décider si le fallback `pos <N>` doit s'afficher.
 */
function identNameHasSpan(
	name: string | undefined,
	identSpans: PgErrorInfo["identSpans"]
): boolean {
	if (typeof name !== "string" || identSpans == null) return false;
	const spans = (identSpans as Record<string, unknown>)[name];
	if (!Array.isArray(spans)) return false;
	return spans.some(
		(v) =>
			Array.isArray(v) &&
			v.length === 2 &&
			typeof v[0] === "number" &&
			typeof v[1] === "number"
	);
}

/**
 * Vrai s'il existe au moins un ident quoté dans le message pg
 * (`column "foo" does not exist`, `relation "bar" does not exist`, etc.)
 * qui a une entrée dans identSpans. Rapide : arrête au premier match.
 */
function identMatchesInSpans(
	message: string | undefined,
	identSpans: PgErrorInfo["identSpans"]
): boolean {
	if (typeof message !== "string" || identSpans == null) return false;
	for (const match of message.matchAll(/"([^"]+)"/g)) {
		if (match[1] !== undefined && identNameHasSpan(match[1], identSpans)) {
			return true;
		}
	}
	return false;
}

/**
 * Rend un chip label/name — cliquable si `identSpans[name]` porte au moins
 * un span (Phase 3b-lite). Le clic focus le premier match ; si l'ident
 * apparaît plusieurs fois on l'indique via `×N`.
 */
function renderIdentChip(
	label: string,
	name: string,
	identSpans: PgErrorInfo["identSpans"],
	onFocusSpan?: (span: SerializedSpan) => void
): React.ReactNode {
	const rawSpans = identSpans?.[name];
	const spans = Array.isArray(rawSpans)
		? rawSpans.filter(
				(v): v is SerializedSpan =>
					Array.isArray(v) &&
					v.length === 2 &&
					typeof v[0] === "number" &&
					typeof v[1] === "number"
			)
		: [];
	const firstSpan = spans[0];
	const clickable = firstSpan !== undefined && onFocusSpan !== undefined;
	if (!clickable) {
		return (
			<span style={chipBaseStyle}>
				<span style={chipLabelStyle}>{label}</span>
				<span style={chipValueStyle}>{name}</span>
			</span>
		);
	}
	const total = spans.length;
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

/** Convertit un pgError structuré en `ParsedError` (source unifiée pour l'UI). */
function fromPgError(pgError: PgErrorInfo): ParsedError {
	return {
		message: pgError.message,
		details: pgError.detail !== undefined ? [pgError.detail] : [],
		...(pgError.code !== undefined ? { sqlstate: pgError.code } : {}),
		...(pgError.hint !== undefined ? { hint: pgError.hint } : {})
	};
}

// Formes canoniques du backend (cf. describePg/MongoExecutionError) :
//   "Erreur côté CLI: <msg> -- SQLSTATE 42883 -- hint: No operator matches…"
//   "Erreur côté CLI: <msg> -- CommandFailed"
// Le préfixe "Erreur côté CLI:" est ajouté par db-connections-proxy.ts. Le segment
// séparateur est le tiret cadratin entouré d'espaces (` -- `), aussi produit par
// nos helpers -- c'est notre contrat de parsing.
const PREFIX_RE = /^(?:Erreur côté CLI|Erreur côté serveur)\s*:\s*/i;
// U+2014 (em dash) construit via code point : le transformer oxc/rolldown utilisé
// par vitest refuse le glyphe littéral dans le fichier source (`Invalid Character`).
const SEGMENT_SPLIT = ` ${String.fromCharCode(0x2014)} `;
const SQLSTATE_RE = /^SQLSTATE\s+([0-9A-Z]{5})$/;
const HINT_RE = /^hint\s*:\s*(.+)$/i;

/**
 * Parseur tolérant (fallback pour messages non structurés) : sur toute forme
 * non-canonique (message court, ancien format, exception JS random), on
 * retourne juste `{ message: raw }` et l'UI dégrade gracefully.
 */
export function parseErrorMessage(raw: string): ParsedError {
	const trimmed = raw.replace(PREFIX_RE, "").trim();
	if (trimmed.length === 0) {
		return { message: raw, details: [] };
	}
	const segments = trimmed.split(SEGMENT_SPLIT);
	const first = segments[0]?.trim() ?? raw;
	if (segments.length === 1) {
		return { message: first, details: [] };
	}
	let sqlstate: string | undefined;
	let hint: string | undefined;
	let codeName: string | undefined;
	const details: string[] = [];
	for (const seg of segments.slice(1)) {
		const s = seg.trim();
		if (s.length === 0) continue;
		const sqlstateMatch = SQLSTATE_RE.exec(s);
		if (sqlstateMatch) {
			sqlstate = sqlstateMatch[1];
			continue;
		}
		const hintMatch = HINT_RE.exec(s);
		if (hintMatch) {
			hint = hintMatch[1];
			continue;
		}
		// Un identifiant Mongo (codeName) : mot unique en TitleCase/CamelCase, pas
		// de ponctuation. Heuristique volontairement stricte pour ne pas capturer
		// des morceaux de message qui ressembleraient à ça.
		if (
			codeName === undefined &&
			/^[A-Z][A-Za-z0-9]{2,40}$/.test(s) &&
			!s.includes(" ")
		) {
			codeName = s;
			continue;
		}
		details.push(s);
	}
	return {
		message: first,
		details,
		...(sqlstate !== undefined ? { sqlstate } : {}),
		...(codeName !== undefined ? { codeName } : {}),
		...(hint !== undefined ? { hint } : {})
	};
}
