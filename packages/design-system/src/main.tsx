import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/spotlight/styles.css";

import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { theme } from "./theme";

export const DesignSystemProvider = ({
	children,
}: {
	children: React.ReactNode;
}) => {
	return (
		<MantineProvider theme={theme}>
			<Notifications />
			{children}
		</MantineProvider>
	);
};
