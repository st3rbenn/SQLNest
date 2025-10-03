import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";
import { theme } from "./theme";

export const DesignSystemProvider = ({
	children,
}: {
	children: React.ReactNode;
}) => {
	return <MantineProvider theme={theme}>{children}</MantineProvider>;
};
