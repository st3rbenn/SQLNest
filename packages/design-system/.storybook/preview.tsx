import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";
import addonTest from "@storybook/addon-vitest";
import addonDocs from "@storybook/addon-docs";
import addonA11y from "@storybook/addon-a11y";

import { theme } from "../src/theme";
import { definePreview } from "@storybook/react-vite";
import { themes } from "storybook/theming";

const decorators = [
	(renderStory: any) => (
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
