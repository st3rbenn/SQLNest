/**
 * SQL d'une migration (ADR-037 D3) : le DDL que SNQL exécuterait, en texte
 * seul. Un fichier de migration n'a pas de paramètres liés : leurs valeurs
 * sont écrites en littéraux. En tête, le SNQL d'origine en commentaire.
 */

import type { NativeQuery, SqlQuery } from "@sqlnest/snql";

const PLACEHOLDER_RE: Readonly<Record<string, RegExp>> = {
	postgres: /\$(\d+)/y,
	mssql: /@p(\d+)/y
};
const TRAILING_SEMICOLON_RE = /;\s*$/;

export function migrationSql(native: NativeQuery, src: string): string {
	const header = src
		.trim()
		.split("\n")
		.map((line, i) => (i === 0 ? `-- SQLNest : ${line}` : `--   ${line}`));
	return `${[...header, body(native)].join("\n")}\n`;
}

function body(native: NativeQuery): string {
	if (native.kind === "sql") return statement(native);
	if (native.kind !== "transaction") {
		throw new Error(
			`Migration : DDL ${native.kind} sans forme SQL (moteur ${native.engine})`
		);
	}
	const statements = native.steps.flatMap((step) =>
		step.kind === "statement" ? [statement(step.query)] : []
	);
	// Postgres joue un fichier à plusieurs instructions dans une transaction
	// implicite ; SQL Server, non.
	return native.engine === "mssql"
		? ["SET XACT_ABORT ON;", "BEGIN TRAN;", ...statements, "COMMIT;"].join("\n")
		: statements.join("\n");
}

function statement(query: SqlQuery): string {
	const text = inlineParams(query);
	return TRAILING_SEMICOLON_RE.test(text) ? text : `${text};`;
}

/** Paramètres `$n` (Postgres) ou `@pn` (SQL Server) remplacés par leurs littéraux, hors chaînes. */
function inlineParams(query: SqlQuery): string {
	if (query.params.length === 0) return query.text;
	const placeholder = PLACEHOLDER_RE[query.engine];
	if (placeholder === undefined) {
		throw new Error(
			`Migration : paramètres ${query.engine} non pris en charge`
		);
	}
	const { text } = query;
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i] as string;
		if (c === "'") {
			const end = closingQuote(text, i);
			out += text.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		placeholder.lastIndex = i;
		const m = placeholder.exec(text);
		if (m !== null) {
			const index = Number(m[1]) - 1;
			if (index < 0 || index >= query.params.length) {
				throw new Error(`Migration : paramètre ${m[0]} sans valeur`);
			}
			out += literal(query.params[index], query.engine);
			i += m[0].length;
			continue;
		}
		out += c;
		i += 1;
	}
	return out;
}

/** Index de la `'` qui ferme la chaîne ouverte en `open` (`''` est une quote échappée). */
function closingQuote(text: string, open: number): number {
	for (let i = open + 1; i < text.length; i += 1) {
		if (text[i] !== "'") continue;
		if (text[i + 1] === "'") {
			i += 1;
			continue;
		}
		return i;
	}
	return text.length - 1;
}

function literal(value: unknown, engine: string): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number" || typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "boolean") {
		if (engine === "mssql") return value ? "1" : "0";
		return value ? "TRUE" : "FALSE";
	}
	const text =
		value instanceof Date
			? value.toISOString()
			: typeof value === "string"
				? value
				: JSON.stringify(value);
	const quoted = `'${text.replace(/'/g, "''")}'`;
	return engine === "mssql" ? `N${quoted}` : quoted;
}
