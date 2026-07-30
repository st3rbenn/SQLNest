import { AppShell as MantineAppShell } from "@mantine/core";
import type { ReactNode } from "react";

export type AppShellProps = {
	header: ReactNode;
	headerHeight?: number;
	children: ReactNode;
};

export function AppShell({
	header,
	headerHeight = 50,
	children,
}: AppShellProps) {
	return (
		<MantineAppShell header={{ height: headerHeight }} padding={0}>
			<MantineAppShell.Header
				role="banner"
				withBorder
				style={{ display: "flex", alignItems: "center" }}
			>
				{header}
			</MantineAppShell.Header>
			<MantineAppShell.Main>{children}</MantineAppShell.Main>
		</MantineAppShell>
	);
}
