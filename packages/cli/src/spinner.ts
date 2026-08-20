/**
 * Spinner minimaliste — cycle Braille sur `\r` en TTY, fallback plain-log
 * préfixé `[sqlnest]` en non-TTY (CI, pipe, redirection). Aucune dep
 * externe : les frames et les escapes ANSI sont locaux, pas de `ora`.
 *
 * Guard `isTTY` reproduit le pattern défensif de `prompts.ts:135`
 * — mais sans throw : on log plainement à chaque `update`/`succeed`,
 * les scripts CI restent lisibles.
 *
 * Sortie et détection TTY sont injectables via `SpinnerOptions` — les
 * tests unit fournissent des stubs.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_INTERVAL_MS = 80;

/** Erase-to-end-of-line ANSI — sans ça, une transition vers un texte
 *  plus court laisse les caractères de l'ancien texte à droite. */
const CLEAR_EOL = "\x1b[K";

export interface SpinnerHandle {
	/** Change le label affiché à côté du spinner (TTY) OU log une nouvelle
	 *  ligne préfixée `[sqlnest]` (non-TTY). */
	update(text: string): void;
	/** Arrête le spinner et imprime une ligne finale `✓ text`. */
	succeed(text: string): void;
	/** Arrête le spinner sans imprimer (nettoie la ligne en TTY). Utile
	 *  au moment de gérer une erreur — on veut nettoyer la ligne avant
	 *  que le caller print son propre message d'erreur. */
	stop(): void;
}

export interface SpinnerOptions {
	/** Écriture bytes bruts pour le TTY path (default `process.stdout.write`).
	 *  Doit gérer `\r` et les escapes ANSI — pas de newline ajouté. */
	readonly write?: (chunk: string) => void;
	/** Écriture d'une ligne complète pour le fallback non-TTY (default
	 *  `console.log`). Le newline est géré par le logger. */
	readonly log?: (line: string) => void;
	/** Force TTY behavior (test) — default `process.stdout.isTTY ?? false`. */
	readonly isTty?: boolean;
	/** Injectable pour test — default `setInterval`/`clearInterval` globaux. */
	readonly setInterval?: (fn: () => void, ms: number) => unknown;
	readonly clearInterval?: (handle: unknown) => void;
}

export function createSpinner(
	initialText: string,
	opts: SpinnerOptions = {}
): SpinnerHandle {
	const isTty = opts.isTty ?? Boolean(process.stdout.isTTY);
	const log = opts.log ?? ((line: string): void => console.log(line));

	if (!isTty) {
		log(`[sqlnest] ${initialText}`);
		return {
			update(text: string): void {
				log(`[sqlnest] ${text}`);
			},
			succeed(text: string): void {
				log(`✓ ${text}`);
			},
			stop(): void {
				// Rien à nettoyer en non-TTY — les lignes sont déjà commit.
			}
		};
	}

	const write =
		opts.write ?? ((chunk: string): void => void process.stdout.write(chunk));
	const setIntervalFn =
		opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
	const clearIntervalFn =
		opts.clearInterval ??
		((handle: unknown) =>
			clearInterval(handle as ReturnType<typeof setInterval>));

	let text = initialText;
	let frame = 0;
	let stopped = false;

	const render = (): void => {
		write(`\r${FRAMES[frame]} ${text}${CLEAR_EOL}`);
	};
	render();
	const handle = setIntervalFn(() => {
		frame = (frame + 1) % FRAMES.length;
		render();
	}, FRAME_INTERVAL_MS);

	return {
		update(next: string): void {
			if (stopped) return;
			text = next;
			render();
		},
		succeed(final: string): void {
			if (stopped) return;
			stopped = true;
			clearIntervalFn(handle);
			write(`\r✓ ${final}${CLEAR_EOL}\n`);
		},
		stop(): void {
			if (stopped) return;
			stopped = true;
			clearIntervalFn(handle);
			write(`\r${CLEAR_EOL}`);
		}
	};
}
