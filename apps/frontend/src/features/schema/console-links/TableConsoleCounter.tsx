import { Menu } from "@mantine/core";
import { IconPlus, IconTerminal2 } from "@tabler/icons-react";
import { type CSSProperties, useContext } from "react";
import { ConsoleLinksContext } from "./ConsoleLinksContext";

const counterStyle = (active: boolean): CSSProperties => ({
	display: "inline-flex",
	alignItems: "center",
	gap: 3,
	padding: "1px 5px",
	border: 0,
	borderRadius: "var(--sqlnest-radius-4)",
	background: active ? "var(--sqlnest-accent)" : "rgba(255,255,255,0.12)",
	color: "var(--sqlnest-text-primary)",
	fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
	fontSize: 10,
	fontWeight: 700,
	lineHeight: "15.5px",
	letterSpacing: 0.3,
	cursor: "pointer"
});

const menuClassNames = { item: "sqlnest-menu-item" } as const;

function rows(count: number): string {
	return `${count} ligne${count > 1 ? "s" : ""}`;
}

/**
 * Compteur des consoles rattachées à une table, dans son en-tête. Le clic
 * ouvre leur liste ; une table sans console n'affiche rien.
 */
export function TableConsoleCounter({
	table
}: {
	readonly table: string;
}): React.ReactNode {
	const links = useContext(ConsoleLinksContext);
	const entries = links?.byTable.get(table);
	if (links === null || entries === undefined || entries.length === 0) {
		return null;
	}
	const active = entries.some((e) => e.id === links.openId);
	return (
		<Menu
			shadow="md"
			width={260}
			position="bottom-start"
			offset={6}
			radius="var(--sqlnest-radius-8)"
			classNames={menuClassNames}
		>
			<Menu.Target>
				<button
					type="button"
					className="nodrag nopan"
					style={counterStyle(active)}
					aria-label={`${entries.length} console${entries.length > 1 ? "s" : ""}`}
					// Le compteur n'est pas la table : ni sélection, ni focus.
					onPointerDown={(e) => e.stopPropagation()}
					onMouseDown={(e) => e.stopPropagation()}
					onClick={(e) => e.stopPropagation()}
					onDoubleClick={(e) => e.stopPropagation()}
				>
					<IconTerminal2 size={11} stroke={2.2} aria-hidden />
					{entries.length}
				</button>
			</Menu.Target>
			{/* Le menu vit dans un portail, mais ses clics remontent l'arbre
			    React jusqu'à la table : sans cet arrêt, choisir une console
			    sélectionnerait et focaliserait la table. */}
			<Menu.Dropdown
				onClick={(e) => e.stopPropagation()}
				onDoubleClick={(e) => e.stopPropagation()}
			>
				{entries.map((entry) => (
					<Menu.Item
						key={entry.id}
						leftSection={<IconTerminal2 size={14} stroke={2} aria-hidden />}
						rightSection={
							entry.lastResult !== undefined ? (
								<span style={{ whiteSpace: "nowrap" }}>
									{rows(entry.lastResult.rowCount)}
								</span>
							) : undefined
						}
						onClick={() => links.open(entry.id)}
					>
						<span
							style={{
								display: "block",
								maxWidth: 150,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap"
							}}
						>
							{entry.title}
						</span>
					</Menu.Item>
				))}
				<Menu.Divider />
				<Menu.Item
					leftSection={<IconPlus size={14} stroke={2} aria-hidden />}
					onClick={() => links.createFor(table)}
				>
					Nouvelle console
				</Menu.Item>
			</Menu.Dropdown>
		</Menu>
	);
}
