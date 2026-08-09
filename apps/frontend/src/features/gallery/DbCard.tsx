import { Link } from "@tanstack/react-router";
import type { CSSProperties, MouseEvent } from "react";
import type { DbConnection } from "../db-connections/useDbConnections";
import { useSchema } from "../schema/useSchema";
import { MiniSchemaPreview } from "./MiniSchemaPreview";

interface Props {
	readonly connection: DbConnection;
	/** `true` si CETTE card est en cours de prefetch (blur + ring bleu
	 *  pour indiquer laquelle l'user vient de cliquer). */
	readonly isPending?: boolean;
	/** Handler intercepté par le hook `useNavigateToCanvas` — prefetch
	 *  schema puis navigate. Omit → comportement Link natif. */
	readonly onClick?: (
		e: MouseEvent<HTMLAnchorElement>,
		connectionId: string
	) => void;
}

const linkStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	textDecoration: "none",
	color: "inherit",
	cursor: "pointer",
	border: "1px solid var(--sqlnest-border)",
	borderRadius: 12,
	overflow: "hidden",
	background: "var(--sqlnest-surface)"
};

const infoBlockStyle: CSSProperties = {
	padding: "10px 12px",
	borderTop: "1px solid var(--sqlnest-border)"
};

const nameStyle: CSSProperties = {
	fontSize: 13,
	fontWeight: 600,
	color: "var(--sqlnest-text-primary)",
	whiteSpace: "nowrap",
	overflow: "hidden",
	textOverflow: "ellipsis"
};

const metaStyle: CSSProperties = {
	fontSize: 11,
	color: "var(--sqlnest-text-tertiary)",
	marginTop: 3,
	display: "flex",
	alignItems: "center",
	gap: 6
};

// Nom d'engine à côté du canvas name — même weight/color que le meta
// footer, distinct du name (font-weight 600).
const engineLabelStyle: CSSProperties = {
	fontSize: 12,
	fontWeight: 400,
	color: "var(--sqlnest-text-secondary)"
};

/**
 * Card d'une db_connection dans la gallery. Click → navigate vers son
 * canvas. Rendu = preview mini-schema + nom + engine + last-seen relatif.
 * Le hover state ajoute un ring bleu autour de la preview (transition
 * gérée via CSS `:hover` — voir le style de conteneur).
 */
export function DbCard({ connection, isPending, onClick }: Props) {
	const meta = formatRelative(connection.lastSeenAt ?? connection.activeSince);
	// Réutilise le cache TanStack Query du useSchema de la preview — 0 fetch
	// supplémentaire. `undefined` tant que la preview n'a pas encore chargé
	// (ou si CLI hors ligne, via l'`enabled` du hook côté null).
	const isOnline = connection.isOnline ?? true;
	const { data: schema } = useSchema(isOnline ? connection.id : null);
	return (
		<Link
			to="/canvas/$connId"
			params={{ connId: connection.id }}
			style={linkStyle}
			className={
				isPending
					? "sqlnest-db-card sqlnest-db-card--pending"
					: "sqlnest-db-card"
			}
			onClick={onClick ? (e) => onClick(e, connection.id) : undefined}
		>
			<div className="sqlnest-db-card__preview">
				<MiniSchemaPreview
					connectionId={connection.id}
					isOnline={connection.isOnline ?? true}
					snapshot={connection.lastPreviewSnapshot ?? null}
				/>
			</div>
			<div style={infoBlockStyle}>
				<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
					<EngineIcon engine={connection.engine} />
					<span style={nameStyle}>{connection.name}</span>
					<span style={{ color: "var(--sqlnest-border)" }}>·</span>
					<span style={engineLabelStyle}>
						{engineLabel(connection.engine)}
					</span>
				</div>
				<div style={metaStyle}>
					<span>{meta}</span>
					{schema ? (
						<>
							<span style={{ color: "var(--sqlnest-border)" }}>·</span>
							<span>
								{schema.collections.length} tables · {schema.relations.length}{" "}
								rel.
							</span>
						</>
					) : null}
				</div>
			</div>
		</Link>
	);
}

function EngineIcon({ engine }: { readonly engine: string }): React.ReactNode {
	// Même couleur que les icônes sidebar (Recents/Canvas) — neutre, ne
	// tire pas l'attention comme le bleu accent qui suggérait qu'on peut
	// interagir avec.
	return (
		<svg
			width={12}
			height={12}
			viewBox="0 0 24 24"
			fill="none"
			stroke="var(--sqlnest-text-cream)"
			strokeWidth={2}
			aria-hidden="true"
		>
			<title>{engine}</title>
			<rect x={4} y={4} width={16} height={16} rx={2} />
			<path d="M4 10h16M10 4v16" />
		</svg>
	);
}

function engineLabel(engine: string): string {
	if (engine === "postgres") return "Postgres";
	if (engine.startsWith("mongo")) return "MongoDB";
	return engine;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function formatRelative(isoDate: string): string {
	const then = new Date(isoDate).getTime();
	if (Number.isNaN(then)) return "";
	const diff = Date.now() - then;
	if (diff < MINUTE) return "à l'instant";
	if (diff < HOUR) return `il y a ${Math.floor(diff / MINUTE)} min`;
	if (diff < DAY) return `il y a ${Math.floor(diff / HOUR)} h`;
	const days = Math.floor(diff / DAY);
	if (days < 7) return `il y a ${days} j`;
	if (days < 30) return `il y a ${Math.floor(days / 7)} sem`;
	if (days < 365) return `il y a ${Math.floor(days / 30)} mois`;
	return `il y a ${Math.floor(days / 365)} an`;
}
