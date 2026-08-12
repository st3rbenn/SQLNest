/**
 * Bloc erreur structuré pour la console SNQL. Parse le message enrichi que le
 * backend compose via `describePgExecutionError` / `describeMongoExecutionError`
 * (cf. `packages/engine/src/{postgres,mongo}/adapter.ts`) -- forme canonique :
 *
 *   [Erreur côté CLI: ]<message natif> -- SQLSTATE <code> -- <detail> -- hint: <hint>
 *
 * Chaque segment est optionnel ; le parseur retombe sur l'affichage brut si le
 * format ne matche pas. Le message natif est rendu en monospace wrapped (c'est
 * du texte technique où les identifiants et opérateurs comptent), SQLSTATE
 * apparaît en badge, le hint sur une ligne à part préfixée d'un pictogramme.
 *
 * Bouton copy : le texte brut (avant parse) va au presse-papier -- pour coller
 * dans un ticket ou un chat, on veut la forme complète, pas la version rendue.
 */

import { showNotification } from "@sqlnest/design-system";
import { IconAlertCircle, IconBulb, IconCopy } from "@tabler/icons-react";
import type { CSSProperties } from "react";

interface ErrorBlockProps {
	readonly error: Error;
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

export function ErrorBlock({ error }: ErrorBlockProps): React.ReactNode {
	const parsed = parseErrorMessage(error.message);

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
				{parsed.sqlstate !== undefined ? (
					<span style={badgeStyle} title="SQLSTATE Postgres">
						{parsed.sqlstate}
					</span>
				) : null}
				{parsed.codeName !== undefined ? (
					<span style={badgeStyle} title="MongoDB codeName">
						{parsed.codeName}
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
			<div style={messageStyle}>{parsed.message}</div>
			{parsed.details.map((detail, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: les segments detail
				// viennent d'un parse déterministe -- l'ordre est stable pour un message donné.
				<div key={i} style={detailStyle}>
					{detail}
				</div>
			))}
			{parsed.hint !== undefined ? (
				<div style={hintRowStyle}>
					<IconBulb size={13} stroke={2} style={hintIconStyle} />
					<span>{parsed.hint}</span>
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
 * Parseur tolérant : sur toute forme non-canonique (message court, ancien format,
 * exception JS random), on retourne juste `{ message: raw }` et l'UI dégrade
 * gracefully vers un simple bloc texte.
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
