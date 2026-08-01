import { Button, Group, Modal, Text } from "@mantine/core";
import type { ReactNode } from "react";

export type ConfirmModalProps = {
	opened: boolean;
	onClose: () => void;
	onConfirm: () => void;
	title: string;
	message: ReactNode;
	confirmLabel?: string;
	cancelLabel?: string;
	destructive?: boolean;
};

/**
 * Modal générique de confirmation. Le bouton Confirmer ferme le modal
 * (`onClose`) avant d'appeler `onConfirm`, ce qui évite tout flash visuel
 * dû à un re-render intermédiaire du contenu qui vient d'être invalidé.
 *
 * Escape / clic backdrop appellent `onClose` seuls (comportement Mantine
 * par défaut). `destructive` teinte le bouton confirm en rouge.
 */
export function ConfirmModal({
	opened,
	onClose,
	onConfirm,
	title,
	message,
	confirmLabel = "Confirmer",
	cancelLabel = "Annuler",
	destructive = false,
}: ConfirmModalProps) {
	const handleConfirm = () => {
		onClose();
		onConfirm();
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={title}
			centered
			size="sm"
		>
			<Text size="sm" mb="md">
				{message}
			</Text>
			<Group justify="flex-end" gap="xs">
				<Button variant="default" onClick={onClose}>
					{cancelLabel}
				</Button>
				<Button
					color={destructive ? "red" : undefined}
					onClick={handleConfirm}
				>
					{confirmLabel}
				</Button>
			</Group>
		</Modal>
	);
}
