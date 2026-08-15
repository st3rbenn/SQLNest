/**
 * Prompts interactifs pour le CLI. Chaque forme est isolée pour permettre
 * aux commands d'être testées avec un `Prompter` mocké.
 *
 * ─── Design ───────────────────────────────────────────────────────────
 * Un `defaultPrompter()` détient UNE seule `readline.Interface` partagée
 * pour toute la durée de vie de la commande — chaque prompt réutilise le
 * même `rl.question`. Plusieurs `createInterface` successifs sur le même
 * `process.stdin` causent des races (bytes perdus, close event pré-émis).
 * Le caller doit appeler `prompter.close?.()` en fin (idempotent).
 *
 * ─── Sécurité password ────────────────────────────────────────────────
 * `password` bascule le TTY en raw mode et masque chaque char par `*`.
 * Backspace/Delete supportés, Ctrl-C annule via reject explicite. Le
 * password n'est JAMAIS écrit en clair et n'est JAMAIS transmis en argv.
 * Pendant la saisie, on `rl.pause()` pour éviter que readline double-lise
 * les bytes ; on `rl.resume()` en cleanup pour laisser la place aux
 * prompts suivants.
 *
 * ─── Testabilité ──────────────────────────────────────────────────────
 * Les commands (`add-connection`, `revoke-connection`) reçoivent un
 * `Prompter` injectable — en test on stub `{line, password, confirm}` avec
 * des `vi.fn()`. La mécanique raw-mode / readline est OS-dependent et
 * intestable finement en unit test (validation manuelle CLI).
 */

import {
	createInterface,
	type Interface as ReadlineInterface
} from "node:readline";
import { select } from "@inquirer/prompts";

export interface SelectChoice<T> {
	readonly value: T;
	readonly label: string;
	readonly description?: string;
}

export interface Prompter {
	readonly line: (prompt: string) => Promise<string>;
	readonly password: (prompt: string) => Promise<string>;
	readonly confirm: (prompt: string) => Promise<boolean>;
	/** Menu à navigation clavier (flèches ↑↓, Enter valide, Ctrl-C annule).
	 *  Implémenté via `@inquirer/prompts` en TTY — sur non-TTY (CI, pipe),
	 *  la lib throw explicitement, le caller peut retomber sur `line()`
	 *  avec un prompt numéroté. */
	readonly select: <T>(opts: {
		readonly message: string;
		readonly choices: readonly SelectChoice<T>[];
	}) => Promise<T>;
	/** Optionnel — le prompter par défaut détient un `readline.Interface`
	 *  qu'il faut close en fin de commande. Les mocks n'en ont pas. */
	readonly close?: () => void;
}

export function defaultPrompter(): Prompter {
	// `terminal: false` — l'OS gère l'écho en mode canonical pendant les
	// prompts normaux. Avec `terminal: true`, readline pose son propre
	// handler `keypress` qui écho chaque touche, et il continue à écho
	// pendant le password (même après `rl.pause()`) → on obtenait un
	// double-écho `r*o*o*t*` au lieu de `****`. `terminal: false` permet
	// aussi au raw-mode manuel du password d'être le SEUL en charge de
	// l'affichage pendant la saisie masquée.
	// Ref mutable : `select` (inquirer) prend le contrôle exclusif de stdin
	// (raw mode, keypress handler propre). Après son exit, l'état de stdin
	// n'est pas parfaitement restauré pour un readline pré-existant : le
	// prochain `rl.question` reste bloqué (le user tape sans que rien ne
	// s'affiche, la promise ne résout jamais → « unsettled top-level await »).
	// Fix : on close le rl AVANT le select, on en recrée un après. Un rl
	// est jetable — recréer coûte ~0 (juste un event handler).
	let rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false
	});
	const recreateRl = (): void => {
		rl = createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: false
		});
	};
	return {
		line: (promptText) =>
			new Promise((resolve) => {
				rl.question(promptText, (answer) => resolve(answer));
			}),
		password: (promptText) => promptPasswordWithRl(rl, promptText),
		confirm: async (promptText) => {
			const ans = await new Promise<string>((resolve) => {
				rl.question(promptText, (answer) => resolve(answer));
			});
			const norm = ans.trim().toLowerCase();
			return norm === "y" || norm === "yes" || norm === "o" || norm === "oui";
		},
		select: async <T>(opts: {
			readonly message: string;
			readonly choices: readonly SelectChoice<T>[];
		}): Promise<T> => {
			// `@inquirer/prompts.select` — navigation clavier ↑↓ + Enter, Ctrl-C
			// throw un `ExitPromptError` qu'on relaie brut au caller (le
			// dispatcher CLI l'affiche + return 130 comme n'importe quel SIGINT).
			// Cède stdin à inquirer proprement : close + recreate évite qu'un
			// readline en background maintienne un handler qui interfère avec
			// le raw-mode d'inquirer (et vice-versa au retour).
			rl.close();
			try {
				const value = await select({
					message: opts.message,
					choices: opts.choices.map((c) => ({
						name: c.label,
						value: c.value,
						...(c.description !== undefined ? { description: c.description } : {})
					}))
				});
				return value as T;
			} finally {
				// Restore explicite en cas où inquirer aurait laissé stdin en
				// raw mode / pause (ExitPromptError ou fin normale, même
				// chemin). Sans ça, le prochain rl.question reste muet.
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
				process.stdin.resume();
				recreateRl();
			}
		},
		close: () => rl.close()
	};
}

async function promptPasswordWithRl(
	rl: ReadlineInterface,
	promptText: string
): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) {
		throw new Error(
			"promptPassword requiert un TTY — utilise le mode interactif du CLI."
		);
	}
	process.stdout.write(promptText);
	// Détache readline (`terminal: false` a peu de handlers, mais on pause
	// par sécurité pour ne pas doubler la lecture des bytes).
	rl.pause();
	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");

	return new Promise<string>((resolve, reject) => {
		let buffer = "";
		let done = false;
		const cleanup = (): void => {
			if (done) return;
			done = true;
			// Retour au mode canonical (echo OS ré-activé) pour les prompts
			// line suivants gérés par readline.
			stdin.setRawMode(false);
			stdin.off("data", onData);
			rl.resume();
		};
		const onData = (chunk: string): void => {
			for (const ch of chunk) {
				const code = ch.charCodeAt(0);
				if (ch === "\r" || ch === "\n") {
					cleanup();
					process.stdout.write("\n");
					resolve(buffer);
					return;
				}
				if (code === 3) {
					// Ctrl-C (ETX) — annule proprement au lieu de laisser tomber
					// dans le handler SIGINT du parent qui tuerait le process.
					cleanup();
					process.stdout.write("\n");
					reject(new Error("Annulé par l'utilisateur (Ctrl-C)"));
					return;
				}
				if (code === 8 || code === 127) {
					if (buffer.length > 0) {
						buffer = buffer.slice(0, -1);
						process.stdout.write("\b \b");
					}
					continue;
				}
				if (code < 32) continue;
				buffer += ch;
				process.stdout.write("*");
			}
		};
		stdin.on("data", onData);
	});
}
