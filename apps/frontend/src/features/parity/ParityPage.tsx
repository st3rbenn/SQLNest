/**
 * PM/10 D20 — Landing page `/parity` listant toutes les divergences
 * sémantiques PG↔Mongo documentées dans le registre snql
 * `divergences-mongo-vs-pg.ts` (source unique de vérité PM/8 D7).
 *
 * Table par mitigation type (shim/warn/refus) : SNQL construct · PG behavior
 * · Mongo behavior · recommandation. Consommée par un user qui veut savoir
 * si sa query SNQL va se comporter identiquement PG↔Mongo, ou dans quel cas
 * documenter/refactor.
 *
 * Le registre est le contract — toute PR qui ajoute une divergence l'inscrit
 * ici, la page s'auto-update (import de DIVERGENCES). Aucune duplication.
 *
 * Follow-ups D20 v2 : auto-génération depuis CI en Markdown pour docs statiques,
 * lien direct vers un test-mirror-id qui prouve la divergence, filtrer par
 * engine version (Mongo 4.2/5.0/6.0), badge "livré" vs "reporté" selon
 * `mitigation`.
 */

import {
	DIVERGENCES,
	type DivergenceEntry,
	type DivergenceMitigation
} from "@sqlnest/snql";
import type { CSSProperties } from "react";

const pageStyle: CSSProperties = {
	maxWidth: 1200,
	margin: "0 auto",
	padding: "24px 32px",
	color: "var(--sqlnest-text-primary)",
	background: "var(--sqlnest-background)",
	minHeight: "100vh"
};

const headerStyle: CSSProperties = {
	fontSize: 24,
	fontWeight: 600,
	marginBottom: 8
};

const subtitleStyle: CSSProperties = {
	fontSize: 14,
	color: "var(--sqlnest-text-secondary)",
	marginBottom: 24,
	lineHeight: 1.5
};

const sectionHeaderStyle: CSSProperties = {
	marginTop: 24,
	marginBottom: 12,
	fontSize: 16,
	fontWeight: 600,
	color: "var(--sqlnest-text-primary)"
};

const tableStyle: CSSProperties = {
	width: "100%",
	borderCollapse: "collapse" as const,
	fontSize: 13,
	background: "var(--sqlnest-surface)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 4,
	overflow: "hidden"
};

const thStyle: CSSProperties = {
	textAlign: "left" as const,
	padding: "10px 12px",
	background: "var(--sqlnest-surface-hover)",
	borderBottom: "1px solid var(--sqlnest-border-subtle)",
	fontWeight: 600,
	color: "var(--sqlnest-text-secondary)",
	fontSize: 11,
	textTransform: "uppercase" as const,
	letterSpacing: 0.4
};

const tdStyle: CSSProperties = {
	padding: "10px 12px",
	borderBottom: "1px solid var(--sqlnest-border-subtle)",
	verticalAlign: "top" as const,
	lineHeight: 1.5
};

const constructStyle: CSSProperties = {
	fontFamily:
		"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
	fontSize: 12,
	color: "var(--sqlnest-info, #4a9eff)",
	fontWeight: 500
};

function mitigationBadge(m: DivergenceMitigation): CSSProperties {
	const colors: Record<DivergenceMitigation, string> = {
		shim: "var(--sqlnest-success)",
		warn: "var(--sqlnest-warning)",
		refus: "var(--sqlnest-danger)"
	};
	return {
		display: "inline-block",
		padding: "2px 8px",
		borderRadius: 3,
		fontSize: 11,
		fontWeight: 600,
		textTransform: "uppercase" as const,
		background: `color-mix(in srgb, ${colors[m]} 20%, transparent)`,
		color: colors[m],
		border: `1px solid ${colors[m]}`,
		letterSpacing: 0.4
	};
}

function mitigationLabel(m: DivergenceMitigation): string {
	switch (m) {
		case "shim":
			return "Shim (parité livrée)";
		case "warn":
			return "Documenté (divergence connue)";
		case "refus":
			return "Refus au planner";
	}
}

const SECTION_ORDER: readonly DivergenceMitigation[] = ["shim", "warn", "refus"];

export function ParityPage(): React.ReactNode {
	const grouped = new Map<DivergenceMitigation, DivergenceEntry[]>();
	for (const div of DIVERGENCES) {
		const list = grouped.get(div.mitigation) ?? [];
		list.push(div);
		grouped.set(div.mitigation, list);
	}

	return (
		<div style={pageStyle}>
			<div style={headerStyle}>Parité PG ↔ Mongo — divergences documentées</div>
			<div style={subtitleStyle}>
				SNQL vise une sémantique unifiée cross-engine. Les divergences
				restantes sont listées ici avec leur mitigation :
				<strong> shim</strong> = parité livrée automatiquement,
				<strong> warn</strong> = comportement différent documenté,
				<strong> refus</strong> = refusé au planner avec code typé.
				Source de vérité : registre <code>divergences-mongo-vs-pg.ts</code>{" "}
				(ADR-024 PM/8 D7).
			</div>

			{SECTION_ORDER.map((mitigation) => {
				const entries = grouped.get(mitigation) ?? [];
				if (entries.length === 0) return null;
				return (
					<section key={mitigation}>
						<div style={sectionHeaderStyle}>
							<span style={mitigationBadge(mitigation)}>{mitigation}</span>
							<span style={{ marginLeft: 8 }}>
								{mitigationLabel(mitigation)} — {entries.length}
							</span>
						</div>
						<table style={tableStyle}>
							<thead>
								<tr>
									<th style={{ ...thStyle, width: 200 }}>SNQL</th>
									<th style={thStyle}>PostgreSQL</th>
									<th style={thStyle}>MongoDB</th>
									<th style={{ ...thStyle, width: 260 }}>Recommandation</th>
								</tr>
							</thead>
							<tbody>
								{entries.map((div) => (
									<tr key={div.code}>
										<td style={tdStyle}>
											<div>
												<span style={constructStyle}>
													{div.userFacingHint ?? "—"}
												</span>
											</div>
											<div
												style={{
													fontSize: 11,
													color: "var(--sqlnest-text-tertiary)",
													marginTop: 2
												}}
											>
												{div.title}
											</div>
										</td>
										<td style={tdStyle}>{div.pgBehavior}</td>
										<td style={tdStyle}>{div.mongoBehavior}</td>
										<td style={tdStyle}>
											{div.hintMessage ?? (
												<span
													style={{
														color: "var(--sqlnest-text-tertiary)",
														fontStyle: "italic"
													}}
												>
													Voir docs release notes
												</span>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>
				);
			})}
		</div>
	);
}
