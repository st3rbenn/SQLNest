import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { UserBadge } from "../auth/UserBadge";
import {
	type DbConnection,
	useDbConnections
} from "../db-connections/useDbConnections";
import { useRecentConnectionIds } from "../db-connections/useRecentConnections";
import { TeamSelector } from "../teams/TeamSelector";
import { useCurrentTeam } from "../teams/useCurrentTeam";
import { DbCard } from "./DbCard";
import { useNavigateToCanvas } from "./useNavigateToCanvas";

/**
 * Page d'accueil des DBs — inspirée de Figma "Recents". L'user atterrit
 * ici après login : sidebar minimale à gauche (Bases active, CTA pair CLI
 * en footer), main à droite avec 2 grids (Récentes / Toutes) + card
 * "Nouvelle base".
 *
 * Data :
 *   - `useDbConnections()` : liste complète des db_connection du user
 *     (backend `GET /api/db-connections`).
 *   - `useRecentConnectionIds()` : ids ouverts récemment sur CE device
 *     (localStorage). Filtrés pour ne montrer que ceux qui existent
 *     encore dans la liste backend.
 *
 * Empty state (0 db_connection) : hero centré avec instructions pour
 * connecter la première base via `/connect`.
 */

const pageStyle: CSSProperties = {
	display: "flex",
	minHeight: "100vh",
	// Sidebar + main partagent la même surface — les 3 « barres » du
	// layout (borderRight sidebar, divider user/team, borderBottom
	// PageHead) forment un T régulier qui délimite les zones.
	background: "var(--sqlnest-surface)",
	color: "var(--sqlnest-text-primary)",
	fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif"
};

const sidebarStyle: CSSProperties = {
	width: 260,
	background: "var(--sqlnest-surface)",
	borderRight: "1px solid var(--sqlnest-border)",
	display: "flex",
	flexDirection: "column",
	flexShrink: 0
};

const mainStyle: CSSProperties = {
	flex: 1,
	display: "flex",
	flexDirection: "column",
	minWidth: 0
};

/**
 * Head de la page main — même height que le bloc user de la sidebar
 * (UserBadge trigger ~32px + padding 8px top + 4px bottom = 44px).
 * Alignement horizontal top garanti : la baseline visuelle du titre
 * matche celle du nom user à sa gauche.
 */
const mainHeadStyle: CSSProperties = {
	minHeight: 45,
	boxSizing: "border-box",
	display: "flex",
	alignItems: "center",
	padding: "0 32px",
	borderBottom: "1px solid var(--sqlnest-border)",
	flexShrink: 0
};

const mainHeadTitleStyle: CSSProperties = {
	fontSize: 13,
	fontWeight: 500,
	color: "var(--sqlnest-text-title)",
	margin: 0
};

const mainContentStyle: CSSProperties = {
	flex: 1,
	padding: "24px 32px 32px",
	display: "flex",
	flexDirection: "column",
	gap: 32
};

const gridStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fill, minmax(325px, 1fr))",
	gap: 20
};

/**
 * Styles LOCAUX à la gallery : hover des cards + shimmer skeleton.
 *
 * Les classes `sqlnest-sidebar-item` / `sqlnest-menu-item` (et leurs
 * variants `--active`) sont hoistées dans `packages/design-system/src/
 * tokens.css` — réutilisées par UserBadge, TeamSelector, etc.
 */
const CARD_HOVER_CSS = `
.sqlnest-db-card {
	transition: border-color 160ms ease;
}
.sqlnest-db-card:hover {
	border-color: var(--sqlnest-accent-muted) !important;
}
.sqlnest-db-card--pending {
	border-color: var(--sqlnest-accent-muted) !important;
}
@keyframes sqlnest-skeleton-shimmer {
	0% { background-position: 200% 0; }
	100% { background-position: -200% 0; }
}
`;

/** Vue de la gallery — pilote le titre PageHead ET l'item actif dans
 *  la sidebar. En V1 les 2 vues affichent la même liste (canvas de la
 *  team courante), seul l'affichage change. En V2 « recents » agrégera
 *  cross-team. */
export type GalleryView = "drafts" | "recents";

const VIEW_TITLES: Record<GalleryView, string> = {
	drafts: "Drafts",
	recents: "Recents"
};

export function GalleryPage({ view = "drafts" }: { readonly view?: GalleryView }) {
	const team = useCurrentTeam();
	const teamSlug = team?.slug ?? null;
	const { data: connections, isLoading, error } = useDbConnections(teamSlug);
	const recentIds = useRecentConnectionIds();
	const { pendingId, handleClick } = useNavigateToCanvas();
	const title = VIEW_TITLES[view];

	if (error) {
		return (
			<div style={pageStyle}>
				<Sidebar hasConnections={false} teamSlug={teamSlug} view={view} />
				<main style={mainStyle}>
					<PageHead title={title} />
					<div style={mainContentStyle}>
						<div style={{ color: "var(--sqlnest-danger)" }}>
							Impossible de charger les connections : {error.message}
						</div>
					</div>
				</main>
			</div>
		);
	}

	if (isLoading || connections === undefined) {
		// Chargement silencieux — la sidebar + PageHead sont posées, le
		// contenu attend sans afficher de "Loading…" (bruit visuel).
		return (
			<div style={pageStyle}>
				<Sidebar hasConnections={false} teamSlug={teamSlug} view={view} />
				<main style={mainStyle}>
					<PageHead title={title} />
					<div style={mainContentStyle} />
				</main>
			</div>
		);
	}

	// Empty state : 0 db_connection dispo. Hero centré, CTA vers /connect.
	if (connections.length === 0) {
		return (
			<div style={pageStyle}>
				<Sidebar hasConnections={false} teamSlug={teamSlug} view={view} />
				<main style={mainStyle}>
					<PageHead title={title} />
					<EmptyHero teamSlug={teamSlug} />
				</main>
			</div>
		);
	}

	// Bucket 1 : récentes (localStorage MRU, filtrées sur les existantes)
	const byId = new Map(connections.map((c) => [c.id, c] as const));
	const recent = recentIds
		.map((id) => byId.get(id))
		.filter((c): c is DbConnection => c !== undefined);
	const recentIdSet = new Set(recent.map((c) => c.id));
	const others = connections.filter((c) => !recentIdSet.has(c.id));

	return (
		<div style={pageStyle}>
			<style>{CARD_HOVER_CSS}</style>
			<Sidebar hasConnections={true} teamSlug={teamSlug} view={view} />
			<main style={mainStyle}>
				<PageHead title={title} />
				<div
					style={{
						...mainContentStyle,
						// Blur les cards non-cliquées + pointer-events: none pendant
						// le prefetch. La card pending garde son ring bleu clair (via
						// classe pending) → l'user voit LAQUELLE charge sans que la
						// gallery entière ne devienne insensible visuellement.
						filter: pendingId ? "blur(4px)" : "none",
						pointerEvents: pendingId ? "none" : "auto",
						transition: "filter 180ms ease"
					}}
				>
					{/* Ordre : récents (MRU localStorage) d'abord, puis les
					    autres, puis card « + Nouveau canvas ». La page
					    entière EST « Recents » (PageHead + sidebar) — pas
					    besoin de sub-headings. En V2 le choix de team dans
					    le sélecteur pilote quels canvas apparaissent. */}
					<div style={gridStyle}>
						{recent.map((c) => (
							<DbCard
								key={c.id}
								connection={c}
								onClick={handleClick}
								isPending={pendingId === c.id}
							/>
						))}
						{others.map((c) => (
							<DbCard
								key={c.id}
								connection={c}
								onClick={handleClick}
								isPending={pendingId === c.id}
							/>
						))}
						<NewConnectionCard teamSlug={teamSlug} />
					</div>
				</div>
			</main>
		</div>
	);
}

function Sidebar({
	hasConnections,
	teamSlug,
	view
}: {
	readonly hasConnections: boolean;
	readonly teamSlug: string | null;
	readonly view: GalleryView;
}): React.ReactNode {
	const team = useCurrentTeam();
	return (
		<aside style={sidebarStyle}>
			{/* ── Bloc PERSONAL : user + nav cross-team. ────────────────
			    En V2 « Recents » agrégera les canvas récemment ouverts
			    tous workspaces confondus (own team, external teams,
			    communautaire). En V1 la route n'existe pas encore →
			    marqué disabled avec « bientôt ». */}
			<div style={{ padding: "8px 12px 4px" }}>
				<UserBadge />
			</div>
			<div style={{ padding: "2px 12px 8px" }}>
				{teamSlug ? (
					<NavItem
						label="Recents"
						icon={<ClockIcon />}
						active={view === "recents"}
						to="/team/$teamSlug/recents"
						params={{ teamSlug }}
					/>
				) : (
					<NavItem label="Recents" icon={<ClockIcon />} active={false} />
				)}
			</div>

			{/* Séparateur bloc perso / bloc team — full width. */}
			<div
				style={{
					height: 1,
					background: "var(--sqlnest-border)",
					margin: 0
				}}
			/>

			{/* ── Bloc TEAM : sélecteur team + nav team-scoped. ──────── */}
			<div style={{ padding: "8px 12px 4px" }}>
				{team ? (
					<TeamSelector currentTeam={team} />
				) : (
					// Team pas encore résolue — pas de « Loading… », on
					// laisse juste un slot vide de la même hauteur qu'un
					// trigger pour éviter le layout shift.
					<div style={{ height: 32 }} />
				)}
			</div>
			<div style={{ padding: "2px 12px" }}>
				{teamSlug ? (
					<NavItem
						label="Drafts"
						icon={<DraftIcon />}
						active={view === "drafts"}
						to="/team/$teamSlug"
						params={{ teamSlug }}
					/>
				) : (
					<NavItem label="Drafts" icon={<DraftIcon />} active={false} />
				)}
			</div>

			<div style={{ flex: 1 }} />

			<div style={{ padding: "10px 10px 12px" }}>
				{teamSlug ? (
					<Link
						to="/team/$teamSlug/connect"
						params={{ teamSlug }}
						className="sqlnest-sidebar-item"
						style={{
							display: "flex",
							width: "100%",
							alignItems: "center",
							gap: 7,
							padding: "6px 10px",
							color: "var(--sqlnest-text-secondary)",
							borderRadius: 6,
							fontSize: 12,
							textDecoration: "none",
							boxSizing: "border-box"
						}}
					>
						<svg
							width={12}
							height={12}
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth={2}
							aria-hidden="true"
						>
							<title>Nouveau canvas</title>
							<path d="M12 5v14M5 12h14" />
						</svg>
						<span style={{ flex: 1 }}>Nouveau canvas</span>
						{hasConnections ? (
							<span
								title="Au moins une connection"
								style={{
									width: 5,
									height: 5,
									borderRadius: "50%",
									background: "var(--sqlnest-success)"
								}}
							/>
						) : null}
					</Link>
				) : (
					<Link
						to="/connect"
						className="sqlnest-sidebar-item"
						style={{
							display: "flex",
							width: "100%",
							alignItems: "center",
							gap: 7,
							padding: "6px 10px",
							color: "var(--sqlnest-text-secondary)",
							borderRadius: 6,
							fontSize: 12,
							textDecoration: "none",
							boxSizing: "border-box"
						}}
					>
						<svg
							width={12}
							height={12}
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth={2}
							aria-hidden="true"
						>
							<title>Nouveau canvas</title>
							<path d="M12 5v14M5 12h14" />
						</svg>
						<span style={{ flex: 1 }}>Nouveau canvas</span>
						{hasConnections ? (
							<span
								title="Au moins une connection"
								style={{
									width: 5,
									height: 5,
									borderRadius: "50%",
									background: "var(--sqlnest-success)"
								}}
							/>
						) : null}
					</Link>
				)}
			</div>
		</aside>
	);
}

function NewConnectionCard({
	teamSlug
}: {
	readonly teamSlug: string | null;
}): React.ReactNode {
	const linkProps = teamSlug
		? ({
				to: "/team/$teamSlug/connect" as const,
				params: { teamSlug }
			} as const)
		: ({ to: "/connect" as const } as const);
	return (
		<Link
			{...linkProps}
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 10,
				textDecoration: "none",
				color: "inherit"
			}}
		>
			<div
				style={{
					aspectRatio: "325 / 225",
					background: "transparent",
					border: "1.5px dashed var(--sqlnest-border)",
					borderRadius: 12,
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					gap: 8,
					color: "var(--sqlnest-text-tertiary)"
				}}
			>
				<div
					style={{
						width: 36,
						height: 36,
						borderRadius: 10,
						background: "var(--sqlnest-surface)",
						border: "1px solid var(--sqlnest-border-subtle)",
						display: "flex",
						alignItems: "center",
						justifyContent: "center"
					}}
				>
					<svg
						width={16}
						height={16}
						viewBox="0 0 24 24"
						fill="none"
						stroke="var(--sqlnest-accent)"
						strokeWidth={2.5}
						aria-hidden="true"
					>
						<title>Nouveau canvas</title>
						<path d="M12 5v14M5 12h14" />
					</svg>
				</div>
				<div style={{ fontSize: 12, color: "var(--sqlnest-text-secondary)" }}>
					Nouveau canvas
				</div>
				<div style={{ fontSize: 10.5, color: "var(--sqlnest-text-tertiary)" }}>
					Connexion via CLI
				</div>
			</div>
		</Link>
	);
}

function EmptyHero({
	teamSlug
}: {
	readonly teamSlug: string | null;
}): React.ReactNode {
	const linkProps = teamSlug
		? ({
				to: "/team/$teamSlug/connect" as const,
				params: { teamSlug }
			} as const)
		: ({ to: "/connect" as const } as const);
	return (
		<div
			style={{
				flex: 1,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: 48
			}}
		>
			<div style={{ maxWidth: 480, textAlign: "center" }}>
				<div
					style={{
						width: 56,
						height: 56,
						borderRadius: 14,
						background: "var(--sqlnest-surface)",
						border: "1px solid var(--sqlnest-border-subtle)",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						marginBottom: 20
					}}
				>
					<svg
						width={26}
						height={26}
						viewBox="0 0 24 24"
						fill="none"
						stroke="var(--sqlnest-accent)"
						strokeWidth={1.8}
						aria-hidden="true"
					>
						<title>Aucun canvas</title>
						<ellipse cx={12} cy={6} rx={8} ry={3} />
						<path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
						<path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
					</svg>
				</div>
				<h1
					style={{
						fontSize: 22,
						fontWeight: 700,
						margin: "0 0 10px",
						color: "var(--sqlnest-text-primary)"
					}}
				>
					Aucun canvas
				</h1>
				<p
					style={{
						fontSize: 14,
						color: "var(--sqlnest-text-secondary)",
						lineHeight: 1.55,
						margin: "0 0 22px"
					}}
				>
					SQLNest ouvre chaque base comme un canvas via un CLI qui tourne sur ta
					machine — tes credentials ne quittent jamais ton poste. Lance{" "}
					<code
						style={{
							background: "var(--sqlnest-surface)",
							padding: "2px 6px",
							borderRadius: 4,
							fontSize: 12.5,
							fontFamily: "var(--mantine-font-family-monospace)"
						}}
					>
						sqlnest connect
					</code>{" "}
					pour créer ton premier canvas.
				</p>
				<Link
					{...linkProps}
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: 8,
						padding: "10px 18px",
						borderRadius: 9,
						background: "var(--sqlnest-accent)",
						color: "#fff",
						fontWeight: 600,
						fontSize: 13,
						textDecoration: "none"
					}}
				>
					Nouveau canvas
				</Link>
			</div>
		</div>
	);
}

function PageHead({ title }: { readonly title: string }): React.ReactNode {
	return (
		<div style={mainHeadStyle}>
			<h1 style={mainHeadTitleStyle}>{title}</h1>
		</div>
	);
}

/** Item de navigation sidebar (Recents, Drafts, …). Un seul composant
 *  pour homogénéiser padding / gap / icon-slot avec les triggers
 *  UserBadge / TeamSelector. Le hover est porté par la classe
 *  `sqlnest-sidebar-item` du DS.
 *
 *  Si `to` est fourni → rendu en <Link> TanStack Router (cliquable
 *  vers la route). Sinon → <div> statique (fallback, ex. quand le
 *  slug de team n'est pas encore chargé). */
function NavItem({
	label,
	icon,
	active,
	to,
	params
}: {
	readonly label: string;
	readonly icon: React.ReactNode;
	readonly active: boolean;
	readonly to?: "/team/$teamSlug" | "/team/$teamSlug/recents";
	readonly params?: { readonly teamSlug: string };
}): React.ReactNode {
	const className = active
		? "sqlnest-sidebar-item sqlnest-sidebar-item--active"
		: "sqlnest-sidebar-item";
	const style: CSSProperties = {
		display: "flex",
		alignItems: "center",
		gap: 10,
		padding: "6px 8px",
		color: "var(--sqlnest-text-title)",
		borderRadius: 6,
		fontSize: 12,
		fontWeight: 500,
		cursor: to ? "pointer" : "default",
		textDecoration: "none"
	};
	const inner = (
		<>
			<span
				style={{
					width: 20,
					height: 20,
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					flexShrink: 0
				}}
			>
				{icon}
			</span>
			<span style={{ flex: 1 }}>{label}</span>
		</>
	);
	if (to && params) {
		return (
			<Link to={to} params={params} className={className} style={style}>
				{inner}
			</Link>
		);
	}
	return (
		<div className={className} style={style}>
			{inner}
		</div>
	);
}

function ClockIcon(): React.ReactNode {
	return (
		<svg
			width={14}
			height={14}
			viewBox="0 0 24 24"
			fill="none"
			stroke="var(--sqlnest-text-cream)"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<title>Recents</title>
			<circle cx={12} cy={12} r={9} />
			<path d="M12 7v5l3 2" />
		</svg>
	);
}

function DraftIcon(): React.ReactNode {
	return (
		<svg
			width={14}
			height={14}
			viewBox="0 0 24 24"
			fill="none"
			stroke="var(--sqlnest-text-cream)"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<title>Drafts</title>
			<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
			<path d="M14 3v5h5" />
		</svg>
	);
}
