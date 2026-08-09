import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/spotlight/styles.css";
// Nos tokens — importés APRÈS Mantine pour que `:root` gagne la cascade
// contre les valeurs par défaut de Mantine si elles se chevauchent.
import "./tokens.css";

import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { theme } from "./theme";

export const DesignSystemProvider = ({
	children,
}: {
	children: React.ReactNode;
}) => {
	// `forceColorScheme="dark"` : SQLNest est dark-only pour l'instant.
	// Pas de toggle exposé — le light sera un chantier séparé le jour où on
	// voudra le supporter. Forcer le mode ici évite (a) le FOUC quand Mantine
	// hérite du prefers-color-scheme au premier paint, (b) tout composant
	// utilisant `light: X` dans ses shades de se retrouver en dehors du
	// thème.
	return (
		<MantineProvider theme={theme} forceColorScheme="dark">
			{/* Notifications center global — n'importe quel consumer peut push
			    via `import { notifications } from "@mantine/notifications"`
			    puis `notifications.show({...})`. Position top-center pour ne
			    pas gêner la navigation top-right (UserMenu / avatar). */}
			<Notifications position="top-center" limit={2} />
			{children}
		</MantineProvider>
	);
};
