import { ConfirmModal } from "@sqlnest/design-system";

export type AutoLayoutModalProps = {
	opened: boolean;
	onClose: () => void;
	onConfirm: () => void;
};

/**
 * Confirmation avant de réappliquer l'auto-layout ELK. Geste destructif —
 * écrase les positions user et les rects de frames sans historique undo,
 * d'où la modale obligatoire.
 */
export function AutoLayoutModal({
	opened,
	onClose,
	onConfirm
}: AutoLayoutModalProps) {
	return (
		<ConfirmModal
			opened={opened}
			onClose={onClose}
			onConfirm={onConfirm}
			title="Réappliquer le layout automatique ?"
			message="Toutes les positions des tables et les rects des frames seront remplacés par la disposition calculée automatiquement. Cette action n'est pas annulable pour l'instant."
			destructive
			confirmLabel="Réappliquer"
		/>
	);
}
