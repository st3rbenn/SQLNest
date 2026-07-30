import addonA11y from "@storybook/addon-a11y";
import addonDocs from "@storybook/addon-docs";
import addonTest from "@storybook/addon-vitest";
import { definePreview } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { themes } from "storybook/theming";
import { DesignSystemProvider } from "../src/main";

const decorators = [
	(renderStory: () => ReactNode) => (
		<DesignSystemProvider>{renderStory()}</DesignSystemProvider>
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
