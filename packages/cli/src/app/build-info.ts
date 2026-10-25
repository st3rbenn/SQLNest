// URLs sélectionnées à la compile via `process.env.NODE_ENV`.
// esbuild remplace cette expression par la string littérale "production"
// au build (`--define:process.env.NODE_ENV="production"`) puis fait du
// dead code elimination avec `--minify-syntax`. Résultat dans le bundle
// publié : seule la string prod survit, les URLs localhost ne sont PAS
// présentes dans le binaire — impossible pour un user d'override via
// NODE_ENV côté runtime, la valeur est déjà substituée avant DCE.
// Ternary inline (pas d'intermédiaire) pour permettre le DCE.
export const API_URL =
	process.env.NODE_ENV === "development"
		? "http://localhost:4000"
		: "https://dev.sqlnest.io";
export const FRONTEND_URL =
	process.env.NODE_ENV === "development"
		? "http://localhost:3000"
		: "https://dev.sqlnest.io";
// Injecté par esbuild au build via `--define:__SQLNEST_CLI_VERSION__=<version>`
// (script `build` dans packages/cli/package.json). En dev via tsx, il n'est pas
// défini : la version affichée est `dev`.
declare const __SQLNEST_CLI_VERSION__: string | undefined;
export const CLI_VERSION: string =
	typeof __SQLNEST_CLI_VERSION__ === "string" ? __SQLNEST_CLI_VERSION__ : "dev";
