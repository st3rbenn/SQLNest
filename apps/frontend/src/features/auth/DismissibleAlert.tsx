import { Alert, type AlertProps } from "@mantine/core";
import { type ReactNode, useEffect, useRef } from "react";

interface DismissibleAlertProps
	extends Omit<AlertProps, "onClose" | "withCloseButton"> {
	/** Callback pour clear l'erreur (bouton X + Esc). */
	readonly onDismiss: () => void;
	/** Focus la boîte à l'apparition — annonce le message aux lecteurs d'écran
	 * et permet au user de la fermer immédiatement avec Esc. */
	readonly autoFocusOnMount?: boolean;
	readonly children: ReactNode;
}

/**
 * Alert Mantine + a11y :
 * - `role="alert"` implicite (Mantine le pose déjà) → annoncé aria-live.
 * - Focus déplacé sur l'Alert dès le mount (a11y screen readers + Esc pour
 *   fermer).
 * - `withCloseButton` + `onClose` → dismiss visible (bouton X).
 * - Touche `Escape` → dismiss aussi (raccourci clavier standard pour tout
 *   composant d'erreur/toast).
 *
 * Contrat : monter UNIQUEMENT quand il y a une erreur — pas de rendu
 * conditionnel via `hidden`. Le parent fait `{error ? <DismissibleAlert> : null}`.
 */
export function DismissibleAlert({
	onDismiss,
	autoFocusOnMount = true,
	children,
	...alertProps
}: DismissibleAlertProps) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (autoFocusOnMount && ref.current) ref.current.focus();
	}, [autoFocusOnMount]);
	return (
		<Alert
			{...alertProps}
			ref={ref}
			tabIndex={-1}
			withCloseButton
			onClose={onDismiss}
			onKeyDown={(e) => {
				if (e.key === "Escape") onDismiss();
			}}
		>
			{children}
		</Alert>
	);
}
