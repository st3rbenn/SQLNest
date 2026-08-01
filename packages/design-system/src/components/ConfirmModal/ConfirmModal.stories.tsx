import type { Meta, StoryObj } from "@storybook/react-vite";
import { ConfirmModal } from "./ConfirmModal";

const meta = {
	title: "Components/ConfirmModal",
	component: ConfirmModal,
	args: {
		opened: true,
		onClose: () => {},
		onConfirm: () => {},
	},
} satisfies Meta<typeof ConfirmModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Neutral: Story = {
	args: {
		title: "Confirmer l'action ?",
		message:
			"Cette action va appliquer les changements en attente. Vous pourrez les annuler ensuite.",
	},
};

export const Destructive: Story = {
	args: {
		title: "Réappliquer le layout automatique ?",
		message:
			"Toutes les positions des tables et les rects des frames seront remplacés par la disposition calculée automatiquement. Cette action n'est pas annulable pour l'instant.",
		destructive: true,
		confirmLabel: "Réappliquer",
	},
};
