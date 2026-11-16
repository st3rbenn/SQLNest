import { useSyncExternalStore } from "react";
import { readJson, storageKeys, writeJson } from "../storage/localStore";

/**
 * MRU des db_connections ouvertes récemment. Persiste dans localStorage
 * (clé `storageKeys.recentConnections` → JSON array d'ids, ordre MRU, max 10).
 *
 * Storage LOCAL uniquement — pas de round-trip backend. Chaque device a
 * son propre historique (cohérent avec la sémantique "ouvertes RÉCEMMENT
 * SUR CE DEVICE"). Si l'user ouvre une db qui a été supprimée depuis
 * (côté backend), la gallery la filtre out avant affichage.
 *
 * ─── API ──────────────────────────────────────────────────────────────
 *  - `useRecentConnectionIds()` : hook React, re-renders sur update
 *  - `pushRecentConnection(id)` : appel imperatif (canvas mount effect)
 *  - `clearRecentConnections()` : reset (settings future)
 */

const STORAGE_KEY = storageKeys.recentConnections;
const MAX_ENTRIES = 10;

// Event bus in-process pour que useSyncExternalStore réagisse aux appels
// imperatifs de `pushRecentConnection` même quand ils viennent du même
// tab (le "storage" event browser ne fire QUE cross-tab).
const listeners = new Set<() => void>();

function readStorage(): readonly string[] {
	const parsed = readJson(STORAGE_KEY);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((v): v is string => typeof v === "string");
}

function writeStorage(ids: readonly string[]): void {
	writeJson(STORAGE_KEY, ids);
}

function notify(): void {
	for (const listener of listeners) listener();
}

export function pushRecentConnection(id: string): void {
	const current = readStorage();
	// Dedup + push en tête. Cap à MAX_ENTRIES.
	const next = [id, ...current.filter((existing) => existing !== id)].slice(
		0,
		MAX_ENTRIES
	);
	// Ne pas re-write si identique (évite un notify pour rien).
	if (
		next.length === current.length &&
		next.every((v, i) => v === current[i])
	) {
		return;
	}
	writeStorage(next);
	notify();
}

export function clearRecentConnections(): void {
	writeStorage([]);
	notify();
}

/**
 * Hook React — retourne la liste d'ids MRU. Snapshot stable entre
 * re-renders (retourne la MÊME référence tant que le storage n'a pas
 * changé) pour éviter les re-fetch en cascade sur les consumers.
 */
export function useRecentConnectionIds(): readonly string[] {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

let cachedSnapshot: readonly string[] = readStorage();
let lastSerialized = JSON.stringify(cachedSnapshot);

function getSnapshot(): readonly string[] {
	const current = readStorage();
	const serialized = JSON.stringify(current);
	if (serialized === lastSerialized) return cachedSnapshot;
	lastSerialized = serialized;
	cachedSnapshot = current;
	return cachedSnapshot;
}

function getServerSnapshot(): readonly string[] {
	return [];
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	// Écoute aussi les updates cross-tab (autre onglet SQLNest ouvre une
	// db → la gallery de ce tab se met à jour aussi).
	const onStorage = (e: StorageEvent): void => {
		if (e.key === STORAGE_KEY) listener();
	};
	if (typeof window !== "undefined") {
		window.addEventListener("storage", onStorage);
	}
	return () => {
		listeners.delete(listener);
		if (typeof window !== "undefined") {
			window.removeEventListener("storage", onStorage);
		}
	};
}
