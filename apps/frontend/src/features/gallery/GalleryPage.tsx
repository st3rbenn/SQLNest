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
	background: "var(--sqlnest-canvas-bg)",
	color: "var(--sqlnest-text-primary)",
	fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif"
};

const sidebarStyle: CSSProperties = {
	width: 260,
	background: "var(--sqlnest-surface)",
	borderRight: "1px solid var(--sqlnest-border-subtle)",
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

const mainHeaderStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 16,
	padding: "22px 32px 8px"
};

const mainContentStyle: CSSProperties = {
	flex: 1,
	padding: "24px 32px 32px",
	display: "flex",
	flexDirection: "column",
	gap: 32
};

const sectionHeadingStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	marginBottom: 14
};

const sectionLabelStyle: CSSProperties = {
	fontSize: 11,
	fontWeight: 700,
	color: "var(--sqlnest-text-tertiary)",
	letterSpacing: "0.5px",
	textTransform: "uppercase"
};

const gridStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
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
	transition: border-color 160ms ease, box-shadow 160ms ease;
}
.sqlnest-db-card:hover {
	border-color: var(--sqlnest-accent) !important;
	box-shadow: 0 6px 20px rgba(13, 153, 255, 0.12);
}
.sqlnest-db-card--pending {
	border-color: var(--sqlnest-accent) !important;
	box-shadow: 0 6px 20px rgba(13, 153, 255, 0.2);
}
@keyframes sqlnest-skeleton-shimmer {
	0% { background-position: 200% 0; }
	100% { background-position: -200% 0; }
}
`;

export function GalleryPage() {
	const team = useCurrentTeam();
	const teamSlug = team?.slug ?? null;
	const { data: connections, isLoading, error } = useDbConnections(teamSlug);
	const recentIds = useRecentConnectionIds();
	const { pendingId, handleClick } = useNavigateToCanvas();

	if (error) {
		return (
			<div style={pageStyle}>
				<Sidebar
					hasConnections={false}
					teamSlug={teamSlug}
				/>
				<main style={mainStyle}>
					<div style={mainHeaderStyle}>
						<h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Canvas</h1>
					</div>
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
		return (
			<div style={pageStyle}>
				<Sidebar
					hasConnections={false}
					teamSlug={teamSlug}
				/>
				<main style={mainStyle}>
					<div style={mainHeaderStyle}>
						<h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Canvas</h1>
					</div>
					<div
						style={{
							...mainContentStyle,
							color: "var(--sqlnest-text-tertiary)",
							fontSize: 13
						}}
					>
						Chargement…
					</div>
				</main>
			</div>
		);
	}

	// Empty state : 0 db_connection dispo. Hero centré, CTA vers /connect.
	if (connections.length === 0) {
		return (
			<div style={pageStyle}>
				<Sidebar
					hasConnections={false}
					teamSlug={teamSlug}
				/>
				<main style={mainStyle}>
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
			<Sidebar
				hasConnections={true}
				count={connections.length}
				teamSlug={teamSlug}
			/>
			<main style={mainStyle}>
				<div style={mainHeaderStyle}>
					<h1
						style={{
							margin: 0,
							fontSize: 22,
							fontWeight: 700,
							letterSpacing: "-0.01em"
						}}
					>
						Canvas
					</h1>
				</div>

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
					{recent.length > 0 ? (
						<section>
							<div style={sectionHeadingStyle}>
								<span style={sectionLabelStyle}>Récents</span>
								<div
									style={{
										flex: 1,
										height: 1,
										background: "var(--sqlnest-border-subtle)"
									}}
								/>
							</div>
							<div style={gridStyle}>
								{recent.map((c) => (
									<DbCard
										key={c.id}
										connection={c}
										onClick={handleClick}
										isPending={pendingId === c.id}
									/>
								))}
							</div>
						</section>
					) : null}

					<section>
						<div style={sectionHeadingStyle}>
							<span style={sectionLabelStyle}>
								{recent.length > 0 ? "Autres canvas" : "Tous les canvas"}
							</span>
							<div
								style={{
									flex: 1,
									height: 1,
									background: "var(--sqlnest-border-subtle)"
								}}
							/>
						</div>
						<div style={gridStyle}>
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
					</section>
				</div>
			</main>
		</div>
	);
}

function Sidebar({
	hasConnections,
	count,
	teamSlug
}: {
	readonly hasConnections: boolean;
	readonly count?: number;
	readonly teamSlug: string | null;
}): React.ReactNode {
	const team = useCurrentTeam();
	return (
		<aside style={sidebarStyle}>
			{/* User en top — style Figma "workspace switcher". */}
			<div style={{ padding: "8px 8px 4px" }}>
				<UserBadge />
			</div>

			{/* Séparateur entre l'user et la team, façon Figma. */}
			<div
				style={{
					height: 1,
					background: "var(--sqlnest-border-subtle)",
					margin: "4px 12px 8px"
				}}
			/>

			{/* Team courante en dessous — dropdown pour V2 multi-teams. */}
			<div style={{ padding: "0 8px 8px" }}>
				{team ? (
					<TeamSelector currentTeam={team} />
				) : (
					<div
						style={{
							padding: "6px 8px",
							fontSize: 12,
							color: "var(--sqlnest-text-tertiary)"
						}}
					>
						Chargement de la team…
					</div>
				)}
			</div>

			<div
				style={{
					padding: "2px 8px",
					display: "flex",
					flexDirection: "column"
				}}
			>
				<div
					className="sqlnest-sidebar-item sqlnest-sidebar-item--active"
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "6px 8px",
						color: "var(--sqlnest-text-primary)",
						borderRadius: 6,
						fontSize: 12.5,
						fontWeight: 500,
						cursor: "default"
					}}
				>
					<svg
						width={13}
						height={13}
						viewBox="0 0 24 24"
						fill="none"
						stroke="var(--sqlnest-accent)"
						strokeWidth={2}
						aria-hidden="true"
					>
						<title>Canvas</title>
						<ellipse cx={12} cy={6} rx={8} ry={3} />
						<path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
						<path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
					</svg>
					Canvas
					{count !== undefined ? (
						<span
							style={{
								marginLeft: "auto",
								fontSize: 10.5,
								color: "var(--sqlnest-text-tertiary)"
							}}
						>
							{count}
						</span>
					) : null}
				</div>
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
					aspectRatio: "16 / 10",
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
					Device flow via ton CLI local
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
