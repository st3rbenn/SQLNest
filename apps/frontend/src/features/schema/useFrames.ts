import { useCallback, useEffect, useState } from "react";
import { FRAME_HUES } from "@sqlnest/design-system";
import type { Frame } from "./frames";
import { framesFor } from "./frames";
import type { SchemaModel } from "./schema-model";

/**
 * Signature stable d'un schéma pour la clé localStorage — engine + noms de
 * collections triés. Deux bases distinctes → clés distinctes ; renommer
 * une table → clé distincte (recalcul ok, frames obsolètes ignorés).
 */
function schemaKey(schema: SchemaModel): string {
	const names = schema.collections
		.map((c) => c.name)
		.slice()
		.sort()
		.join(",");
	return `sqlnest:frames:${schema.engine}:${names}`;
}

const HUE_POOL: readonly number[] = [
	FRAME_HUES.users,
	FRAME_HUES.commerce,
	FRAME_HUES.analytics,
	FRAME_HUES.crossrefs,
	FRAME_HUES.events,
	FRAME_HUES.xref
];

/** Prochaine teinte disponible — la moins utilisée par les frames actuels. */
export function nextHue(frames: readonly Frame[]): number {
	const used = new Map<number, number>();
	for (const h of HUE_POOL) used.set(h, 0);
	for (const f of frames) used.set(f.hue, (used.get(f.hue) ?? 0) + 1);
	let best = HUE_POOL[0] ?? 210;
	let bestCount = Infinity;
	for (const [h, c] of used) {
		if (c < bestCount) {
			bestCount = c;
			best = h;
		}
	}
	return best;
}

/**
 * Un nom "Frame N" qui ne collide pas avec un frame existant.
 */
export function nextLabel(frames: readonly Frame[]): string {
	const taken = new Set(frames.map((f) => f.label));
	for (let i = 1; i < 999; i++) {
		const candidate = `Frame ${i}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `Frame ${Date.now()}`;
}

interface FramesApi {
	readonly frames: readonly Frame[];
	readonly frameOfTable: (name: string) => Frame | null;
	readonly createFrame: (tables: readonly string[], label?: string) => Frame;
	readonly removeFrame: (key: string) => void;
	readonly renameFrame: (key: string, label: string) => void;
	readonly removeTableFromFrame: (tableName: string) => void;
}

/**
 * State des frames user-defined, persisté en localStorage par signature de
 * schéma. Semé par `framesFor(schema)` au 1er accès (compat avec les
 * frames statiques du sample). Toutes les mutations ré-écrivent le storage.
 */
export function useFrames(schema: SchemaModel): FramesApi {
	const [frames, setFrames] = useState<readonly Frame[]>(() => {
		if (typeof window === "undefined") return framesFor(schema);
		try {
			const raw = window.localStorage.getItem(schemaKey(schema));
			if (raw !== null) return JSON.parse(raw) as Frame[];
		} catch {
			// storage indisponible ou JSON corrompu — repart des seeds.
		}
		return framesFor(schema);
	});

	// Persist à chaque mutation.
	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			window.localStorage.setItem(schemaKey(schema), JSON.stringify(frames));
		} catch {
			/* quota / private mode */
		}
	}, [frames, schema]);

	// Re-seed quand la signature de schéma change (nouvelle base).
	const key = schemaKey(schema);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const raw = window.localStorage.getItem(key);
		if (raw !== null) {
			try {
				setFrames(JSON.parse(raw) as Frame[]);
				return;
			} catch {
				/* fallthrough */
			}
		}
		setFrames(framesFor(schema));
	}, [key, schema]);

	const frameOfTable = useCallback(
		(name: string): Frame | null =>
			frames.find((f) => f.collections.includes(name)) ?? null,
		[frames]
	);

	const createFrame = useCallback(
		(tables: readonly string[], label?: string): Frame => {
			const uniqueTables = [...new Set(tables)];
			const newFrame: Frame = {
				key: `f-${Date.now()}`,
				label: label ?? nextLabel(frames),
				hue: nextHue(frames),
				collections: uniqueTables
			};
			// Détache ces tables de leurs frames précédents (une table ne
			// peut appartenir qu'à un seul frame — évite l'ambiguïté visuelle).
			setFrames((prev) => [
				...prev.map((f) => ({
					...f,
					collections: f.collections.filter((c) => !uniqueTables.includes(c))
				})),
				newFrame
			]);
			return newFrame;
		},
		[frames]
	);

	const removeFrame = useCallback((key: string) => {
		setFrames((prev) => prev.filter((f) => f.key !== key));
	}, []);

	const renameFrame = useCallback((key: string, label: string) => {
		setFrames((prev) =>
			prev.map((f) => (f.key === key ? { ...f, label } : f))
		);
	}, []);

	const removeTableFromFrame = useCallback((tableName: string) => {
		setFrames((prev) =>
			prev
				.map((f) => ({
					...f,
					collections: f.collections.filter((c) => c !== tableName)
				}))
				.filter((f) => f.collections.length > 0)
		);
	}, []);

	return {
		frames,
		frameOfTable,
		createFrame,
		removeFrame,
		renameFrame,
		removeTableFromFrame
	};
}
