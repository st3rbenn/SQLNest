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

const SAMPLE_TABLES: ReadonlySet<string> = new Set(
	SAMPLE_FRAMES.flatMap((f) => f.collections)
);

/**
 * Regroupe les tables en frames colorés pour l'aperçu macro. Minimum viable
 * 1a : la fixture d'exemple (`SAMPLE_POSTGRES`/`SAMPLE_MONGODB`) porte deux
 * frames statiques ; toute base introspectée avec des tables **hors sample**
 * renvoie une liste vide (les frames sont visuellement trompeurs si une
 * partie des tables du canvas n'est couverte par aucun frame — un frame
 * calculé sur un sous-ensemble se retrouve à côté d'orphelins mal placés).
 * Les frames dérivés d'une heuristique/IA sont hors périmètre —
 * voir vault `The Cross-DB Reader`.
 */
export function framesFor(schema: SchemaModel): Frame[] {
	const names = new Set(schema.collections.map((c) => c.name));
	// Toutes les tables du schéma doivent être couvertes par un frame
	// hardcodé — sinon on hide tout (des orphelins autour d'un frame
	// donneraient un rendu incohérent, cf. bug reviews/addresses).
	const allCovered = [...names].every((c) => SAMPLE_TABLES.has(c));
	if (!allCovered) return [];
	return SAMPLE_FRAMES.map((f) => ({
		...f,
		collections: f.collections.filter((c) => names.has(c))
	})).filter((f) => f.collections.length > 0);
}
