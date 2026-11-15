import { resolve } from "node:path";
import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
	stories: [
		"../src/**/*.mdx",
		"../src/**/*.stories.@(js|jsx|mjs|ts|tsx)",
		// Composants d'app : leurs stories vivent à côté d'eux, dans le frontend.
		"../../../apps/frontend/src/**/*.stories.@(ts|tsx)",
	],
	addons: [
		"@chromatic-com/storybook",
		"@storybook/addon-docs",
		"@storybook/addon-onboarding",
		"@storybook/addon-a11y",
		"@storybook/addon-vitest",
		"storybook-dark-mode",
	],
	framework: {
		name: "@storybook/react-vite",
		options: {},
	},
	// Le frontend importe le design system par son nom de paquet : ici il se
	// résout vers la source, comme dans l'app, pas vers un `dist` à construire.
	viteFinal: (viteConfig) => ({
		...viteConfig,
		resolve: {
			...viteConfig.resolve,
			alias: {
				...(viteConfig.resolve?.alias as Record<string, string> | undefined),
				"@sqlnest/design-system": resolve(__dirname, "../src/index.ts"),
			},
		},
	}),
};
export default config;
