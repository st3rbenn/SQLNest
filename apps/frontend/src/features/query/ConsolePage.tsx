/**
 * Shell fullscreen de la console SNQL — la surface accessible via la
 * route `/team/:slug/canvas/:connId/query`.
 *
 * Le corps (tabs / éditeur / résultats / split) vit dans
 * `ConsoleShellInner`, partagé avec le node canvas T5. Cette page ne
 * porte que ce qui est spécifique au mode fullscreen :
 *   - le wrapper `position: fixed; inset: 0`
 *   - la nav router (retour au canvas, ouverture en popout)
 *   - les hotkeys nav (Escape back, ⌘⇧K détacher)
 */

import { useHotkeys } from "@mantine/hooks";
import { useNavigate } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { ConsoleShellInner } from "./ConsoleShellInner";
import { openConsoleInPopout, useIsPopout } from "./usePopoutWindow";

const pageStyle: CSSProperties = {
	position: "fixed",
	inset: 0
};

export function ConsolePage({
	teamSlug,
	connId,
	initialSource,
	initialAutorun
}: {
	readonly teamSlug: string;
	readonly connId: string;
	readonly initialSource?: string;
	readonly initialAutorun?: boolean;
}): React.ReactNode {
	const navigate = useNavigate();
	const isPopout = useIsPopout();

	function handleDetach(): void {
		openConsoleInPopout(teamSlug, connId);
		// Le tab d'origine repart au canvas — évite d'avoir 2 fenêtres
		// identiques ouvertes sur la même URL.
		if (!isPopout) {
			navigate({
				to: "/team/$teamSlug/canvas/$connId",
				params: { teamSlug, connId }
			});
		}
	}

	function handleBack(): void {
		if (isPopout) {
			window.close();
			return;
		}
		navigate({
			to: "/team/$teamSlug/canvas/$connId",
			params: { teamSlug, connId }
		});
	}

	// Hotkeys nav-specific — l'inner gère ⌘T / ⌘W / ⌘⇧F et le run via
	// SnqlEditor keymap.
	useHotkeys(
		[
			["mod+shift+K", handleDetach, { preventDefault: true }],
			["Escape", handleBack, { preventDefault: false }]
		],
		[]
	);

	return (
		<div style={pageStyle}>
			<ConsoleShellInner
				teamSlug={teamSlug}
				connId={connId}
				initialSource={initialSource}
				initialAutorun={initialAutorun}
				variant="route"
				isPopout={isPopout}
				onDetach={handleDetach}
			/>
		</div>
	);
}
