import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";
import addonA11y from "@storybook/addon-a11y";
import addonDocs from "@storybook/addon-docs";
import addonTest from "@storybook/addon-vitest";
import { definePreview } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { themes } from "storybook/theming";
import { theme } from "../src/theme";

const decorators = [
	(renderStory: () => ReactNode) => (
		<MantineProvider theme={theme}>{renderStory()}</MantineProvider>
	),
];

const parameters = {
	docs: {
		theme: themes.dark,
		codePanel: true,
	},
	grid: {
		cellSize: 15,
		cellAmount: 10,
		opacity: 0.4,
	},
};

export default definePreview({
	addons: [addonDocs(), addonA11y(), addonTest()],
	decorators,
	tags: ["test", "vitest"],
	parameters,
});
