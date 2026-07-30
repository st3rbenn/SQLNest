import { FRAME_HUES } from "@sqlnest/design-system";
import type { SchemaModel } from "./schema-model";

export interface Frame {
	readonly key: string;
	readonly label: string;
	readonly hue: number;
	readonly collections: readonly string[];
}

const SAMPLE_FRAMES: Frame[] = [
	{
		key: "users",
		label: "Utilisateurs",
		hue: FRAME_HUES.users,
		collections: ["users"]
	},
	{
		key: "commerce",
		label: "Commerce",
		hue: FRAME_HUES.commerce,
		collections: ["orders", "products", "order_items", "carts"]
	}
];

/**
 * Regroupe les tables en frames colorés pour l'aperçu macro. Minimum viable
 * 1a : la fixture d'exemple (`SAMPLE_POSTGRES`/`SAMPLE_MONGODB`) porte deux
 * frames statiques ; toute base introspectée renvoie une liste vide (les
 * frames dérivés d'une heuristique/IA sont hors périmètre — voir vault
 * `The Cross-DB Reader`).
 */
export function framesFor(schema: SchemaModel): Frame[] {
	const names = new Set(schema.collections.map((c) => c.name));
	const inSample = SAMPLE_FRAMES.every((f) =>
		f.collections.every((c) => names.has(c) || c === "carts")
	);
	if (!inSample) return [];
	return SAMPLE_FRAMES.map((f) => ({
		...f,
		collections: f.collections.filter((c) => names.has(c))
	})).filter((f) => f.collections.length > 0);
}
