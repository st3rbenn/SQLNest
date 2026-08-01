import { useCallback, useEffect, useRef, useState } from "react";
import { FRAME_HUES } from "@sqlnest/design-system";
import type { Frame, FrameRect } from "./frames";
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
	readonly createFrame: (
		tables: readonly string[],
		options?: { label?: string; rect?: FrameRect }
	) => Frame;
	readonly removeFrame: (key: string) => void;
	readonly renameFrame: (key: string, label: string) => void;
	readonly removeTableFromFrame: (tableName: string) => void;
	readonly addTableToFrame: (frameKey: string, tableName: string) => void;
	readonly moveFrame: (key: string, dx: number, dy: number) => void;
	readonly setFrameRect: (key: string, rect: FrameRect) => void;
}

/**
 * State des frames user-defined, persisté en localStorage par signature de
 * schéma. Semé par `framesFor(schema)` au 1er accès (compat avec les
 * frames statiques du sample). Toutes les mutations ré-écrivent le storage.
 */
function loadFrames(schema: SchemaModel): readonly Frame[] {
	if (typeof window === "undefined") return framesFor(schema);
	try {
		const raw = window.localStorage.getItem(schemaKey(schema));
		if (raw !== null) return JSON.parse(raw) as Frame[];
	} catch {
		// storage indispo / JSON corrompu — repart des seeds.
	}
	return framesFor(schema);
}

export function useFrames(schema: SchemaModel): FramesApi {
	const key = schemaKey(schema);
	const [frames, setFrames] = useState<readonly Frame[]>(() => loadFrames(schema));

	// Track quel `key` est actuellement représenté par `frames` en state.
	// Sert à distinguer un vrai mutate (persist OK) d'un pending re-seed après
	// changement de schéma (persist SKIP, sinon on corromprait le nouveau key
	// avec les vieux frames avant que le re-seed effect ne fire).
	const loadedKey = useRef(key);

	// Re-seed quand la signature de schéma change (nouvelle base).
	useEffect(() => {
		if (loadedKey.current === key) return;
		const loaded = loadFrames(schema);
		loadedKey.current = key;
		setFrames(loaded);
	}, [key, schema]);

	// Persist — seulement quand le key en état matche le key courant.
	useEffect(() => {
		if (typeof window === "undefined") return;
		if (loadedKey.current !== key) return;
		try {
			window.localStorage.setItem(key, JSON.stringify(frames));
		} catch {
			/* quota / private mode */
		}
	}, [key, frames]);

	const frameOfTable = useCallback(
		(name: string): Frame | null =>
			frames.find((f) => f.collections.includes(name)) ?? null,
		[frames]
	);

	const createFrame = useCallback(
		(
			tables: readonly string[],
			options?: { label?: string; rect?: FrameRect }
		): Frame => {
			const uniqueTables = [...new Set(tables)];
			const newFrame: Frame = {
				key: `f-${Date.now()}`,
				label: options?.label ?? nextLabel(frames),
				hue: nextHue(frames),
				collections: uniqueTables,
				...(options?.rect ? { rect: options.rect } : {})
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
		// Un frame vide reste vide — plus de suppression auto. L'utilisateur
		// peut vouloir garder un frame comme conteneur pour y déposer des
		// tables plus tard (drag-in). La suppression manuelle passe par
		// `removeFrame` (menu contextuel ou action explicite).
		setFrames((prev) =>
			prev.map((f) => ({
				...f,
				collections: f.collections.filter((c) => c !== tableName)
			}))
		);
	}, []);

	const addTableToFrame = useCallback(
		(frameKey: string, tableName: string) => {
			setFrames((prev) =>
				prev.map((f) => {
					if (f.key === frameKey) {
						if (f.collections.includes(tableName)) return f;
						return { ...f, collections: [...f.collections, tableName] };
					}
					// Retire de tout autre frame (invariant : une table par frame).
					if (f.collections.includes(tableName)) {
						return {
							...f,
							collections: f.collections.filter((c) => c !== tableName)
						};
					}
					return f;
				})
			);
		},
		[]
	);

	const moveFrame = useCallback((key: string, dx: number, dy: number) => {
		setFrames((prev) =>
			prev.map((f) => {
				if (f.key !== key || !f.rect) return f;
				return {
					...f,
					rect: {
						x: f.rect.x + dx,
						y: f.rect.y + dy,
						width: f.rect.width,
						height: f.rect.height
					}
				};
			})
		);
	}, []);

	const setFrameRect = useCallback((key: string, rect: FrameRect) => {
		setFrames((prev) =>
			prev.map((f) => (f.key === key ? { ...f, rect } : f))
		);
	}, []);

	return {
		frames,
		frameOfTable,
		createFrame,
		removeFrame,
		renameFrame,
		removeTableFromFrame,
		addTableToFrame,
		moveFrame,
		setFrameRect
	};
}
