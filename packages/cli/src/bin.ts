/**
 * Entry point du binaire `sqlnest`.
 *
 * Reste minimaliste — toute la logique dispatch/subcommand vit dans
 * `cli.ts` (`runCli(argv, io)`). Ce fichier :
 *   1. Parse `process.argv.slice(2)` (retire `node` + le chemin bin).
 *   2. Appelle `runCli`.
 *   3. `process.exit` avec le code retourné.
 *
 * Le shebang `#!/usr/bin/env node` est injecté par esbuild via
 * `--banner:js` au build (voir `package.json` script `build`). Ne pas
 * l'ajouter ici — esbuild refuse de compiler du TS commençant par un
 * shebang.
 */

import { runCli } from "./cli";

const code = await runCli(process.argv.slice(2));
process.exit(code);
