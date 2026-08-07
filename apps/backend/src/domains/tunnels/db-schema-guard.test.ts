/**
 * Test-guard « règle 1 sécu » — le backend SQLNest ne stocke **jamais** de
 * credentials de connexion DB.
 *
 * Ce test parse le schéma Drizzle de `packages/db` en runtime et échoue si
 * une colonne porte un nom évocateur (`password`, `url`, `dsn`, `secret`,
 * `dbname`, `hostname`, …). C'est la traduction exécutable d'une contrainte
 * archi (mémoire projet `project-db-connection-cli-tunnel`) : le CLI local
 * matérialise les queries avec ses credentials, le backend ne relaie que
 * des bytes.
 *
 * Une whitelist stricte permet des exceptions justifiées (voir plus bas) —
 * ajouter une entrée sans justification écrite est le signe d'un dérive.
 *
 * Pas de `.int.test.ts` : ce test est pur (parse d'objet Drizzle), pas de
 * DB requise. Il tourne en unit et en CI sans docker.
 */

import { schema } from "@sqlnest/db";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";

/**
 * Tokens dont la présence dans un nom de colonne (split par `_`/`-`)
 * signale un stockage probable de creds. La liste est volontairement
 * large — un false-positive se règle par whitelist justifiée, ce qui
 * force la conversation.
 */
const FORBIDDEN_TOKENS = new Set([
	"password",
	"passwd",
	"pwd",
	"secret",
	"secrets",
	"url",
	"uri",
	"urls",
	"dsn",
	"hostname",
	"credentials",
	"creds"
]);

/**
 * Patterns matched sur le nom complet — attrape les cas où les tokens
 * sont concaténés sans séparateur (`connstring`, `dbname`, `hostname`).
 */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
	/conn(ection)?[_-]?str(ing)?/i,
	/db[_-]?(name|host|port|user|url)/i,
	/host[_-]?name/i
];

/**
 * Whitelist `table.column` (noms DB snake_case). Chaque entrée DOIT
 * porter une justification en commentaire. Si l'ajout est motivé par
 * « c'est pratique », c'est le signal qu'il faut renommer la colonne
 * plutôt que d'y déroger.
 */
const WHITELIST: readonly string[] = [
	// Better Auth v1.6.x — hash argon2id du mot de passe user (jamais le
	// clair). Le nom `password` fait partie du canonical schema Better
	// Auth ; le renommer casserait l'adapter Drizzle. Ce n'est PAS une
	// creds de connexion DB externe — c'est le hash d'auth applicative.
	"account.password"
];

interface Violation {
	readonly location: string;
	readonly reason: string;
}

function inspectColumn(
	tableName: string,
	columnName: string
): Violation | null {
	const location = `${tableName}.${columnName}`;
	if (WHITELIST.includes(location)) return null;

	const tokens = columnName.toLowerCase().split(/[_-]/);
	for (const token of tokens) {
		if (FORBIDDEN_TOKENS.has(token)) {
			return {
				location,
				reason: `token "${token}" est interdit (creds probable)`
			};
		}
	}
	for (const pattern of FORBIDDEN_PATTERNS) {
		if (pattern.test(columnName)) {
			return {
				location,
				reason: `matche pattern ${pattern.source}`
			};
		}
	}
	return null;
}

describe("packages/db schema — règle 1 sécu (aucune col creds DB)", () => {
	test("aucune colonne du schéma ne matche un nom de creds DB (ou est whitelistée avec justification)", () => {
		const tables = Object.values(schema).filter((v): v is PgTable =>
			is(v, PgTable)
		);

		// Sanity : sinon un import cassé masquerait le guard silencieusement.
		expect(tables.length).toBeGreaterThan(0);

		const violations: Violation[] = [];
		for (const table of tables) {
			const tableName = getTableName(table);
			const cols = getTableColumns(table);
			for (const col of Object.values(cols)) {
				const v = inspectColumn(tableName, col.name);
				if (v) violations.push(v);
			}
		}

		expect(violations).toEqual([]);
	});

	// Sanity : le guard fait effectivement quelque chose. Sans ça, une
	// erreur silencieuse dans l'énumération donnerait un test toujours vert.
	test("le guard détecte bien un nom interdit (auto-test)", () => {
		expect(inspectColumn("hypothetical", "database_url")).not.toBeNull();
		expect(inspectColumn("hypothetical", "connection_string")).not.toBeNull();
		expect(inspectColumn("hypothetical", "db_password")).not.toBeNull();
		expect(inspectColumn("hypothetical", "hostname")).not.toBeNull();
		// Contrôle négatif — un nom bénin passe.
		expect(inspectColumn("hypothetical", "user_id")).toBeNull();
		expect(inspectColumn("hypothetical", "cli_pubkey_ed25519")).toBeNull();
		// Whitelist active — l'entrée exacte passe.
		expect(inspectColumn("account", "password")).toBeNull();
	});
});
