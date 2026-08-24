import { useMutation } from "@tanstack/react-query";
import {
	compensate,
	lowerIntrospect,
	parse,
	type Row,
	tokenize
} from "@sqlnest/snql";
import { fetchChecksumHistory } from "../checksum-history/checksumHistoryClient";

const API_BASE = window.CONTEXT.apiBaseUrl;

/**
 * Détecte si la source SNQL cible une table système SQLNest — aujourd'hui :
 * `list schema_events` route backend vers l'audit trail interne (pas la DB
 * user via tunnel). Parse via le vrai lexer/parser SNQL — plus de regex
 * intercept fragile. Erreur parser propagée comme les autres (les mêmes
 * marqueurs éditeur remontent).
 *
 * Renvoie le kind d'introspection SQLNest à router + les postOps lowered pour
 * matérialisation client-side (where/pick/sort/limit sur les rows après
 * fetch), ou null pour le flow proxy tunnel normal.
 */
function detectSqlnestIntrospect(source: string):
	| {
			readonly kind: "schema-events";
			readonly postOps: ReturnType<typeof lowerIntrospect>["postOps"];
	  }
	| null {
	try {
		const stmt = parse(tokenize(source));
		if (
			stmt.operation === "introspect" &&
			stmt.kind === "list-schema-events"
		) {
			const plan = lowerIntrospect(stmt);
			return { kind: "schema-events", postOps: plan.postOps };
		}
	} catch {
		// Erreur parser → laisse le flow normal remonter le vrai message
		// via le POST proxy (le backend/CLI la re-parse et renvoie).
	}
	return null;
}

/**
 * Convertit une page d'historique en `QueryResult` compatible avec le rendu
 * de la console. Les colonnes sont hard-codées (shape stable de la table
 * système), les rows viennent tel quel de l'API SQLNest.
 */
function schemaEventsToQueryResult(
	entries: ReadonlyArray<{
		id: string;
		dbSchemaChecksum: string;
		dbConnectionId: string | null;
		seenAt: string;
	}>
): QueryResult {
	return {
		columns: [
			{ name: "id", type: "string", nullable: false },
			{ name: "seen_at", type: "date", nullable: false },
			{ name: "checksum", type: "string", nullable: false },
			{ name: "db_connection_id", type: "string", nullable: true }
		],
		rows: entries.map((e) => ({
			id: e.id,
			seen_at: e.seenAt,
			checksum: e.dbSchemaChecksum,
			db_connection_id: e.dbConnectionId
		})),
		rowCount: entries.length,
		written: false
	};
}

/**
 * Type SNQL d'une colonne — aligné sur `SnqlType` de
 * `packages/snql/src/schema/model.ts`. Dupliqué ici pour ne pas ajouter
 * `@sqlnest/snql` en dep du frontend (types uniquement de toute façon).
 */
export type SnqlColumnType =
	| "string"
	| "int"
	| "bigint"
	| "float"
	| "decimal"
	| "bool"
	| "date"
	| "json"
	| "array"
	| "uuid"
	| "enum"
	| "unknown";

export interface QueryResultColumn {
	readonly name: string;
	readonly type: SnqlColumnType;
	readonly nullable: boolean;
}

export interface QueryResult {
	readonly columns: readonly QueryResultColumn[];
	readonly rows: readonly Record<string, unknown>[];
	readonly rowCount: number;
	/** `true` = écriture (lignes affectées) ; distingue d'une lecture à 0 ligne. */
	readonly written: boolean;
}

/**
 * Span source SNQL sérialisé `[start, length]` — aligné sur `SerializedSpan`
 * dans `packages/snql/src/codegen/mapper.ts`. Dupliqué ici pour ne pas
 * dépendre de `@sqlnest/snql` côté frontend (types uniquement).
 */
export type SerializedSpan = readonly [start: number, length: number];

/**
 * Détail structuré d'une erreur Postgres — aligné sur `PgErrorInfo` dans
 * `packages/engine/src/errors.ts` et sur le schéma Zod `PgErrorInfoSchema`
 * du backend. `params` + `paramSpans` sont alignés positionnellement sur
 * les `$1..$N` du SQL généré : `paramSpans[i]` (si présent) pointe sur le
 * token SNQL source de `params[i]`.
 */
export interface PgErrorInfo {
	readonly message: string;
	readonly code?: string;
	readonly position?: number;
	readonly detail?: string;
	readonly hint?: string;
	readonly column?: string;
	readonly table?: string;
	readonly constraint?: string;
	readonly params?: readonly unknown[];
	readonly paramSpans?: readonly (SerializedSpan | undefined)[];
	/** Phase 3c : spans des rows d'un INSERT batch — cible la row fautive. */
	readonly rowSpans?: readonly (SerializedSpan | undefined)[];
	/**
	 * Phase 3b-lite : spans par nom d'ident (col/table/alias). Résout
	 * `column "X" does not exist` → toutes les positions de X dans la source.
	 */
	readonly identSpans?: Readonly<Record<string, readonly SerializedSpan[]>>;
}

/**
 * Erreur runtime remontée par le hook `useRunQuery` — enrichit `Error` avec
 * l'éventuel `pgError` structuré (Phase 3a). Sans `pgError` : erreur transport
 * ou HTTP non-`pg` (503 pas de tunnel, 500 interne, etc.).
 */
export class SnqlRuntimeError extends Error {
	readonly pgError?: PgErrorInfo;
	constructor(message: string, pgError?: PgErrorInfo) {
		super(message);
		this.name = "SnqlRuntimeError";
		if (pgError !== undefined) this.pgError = pgError;
	}
}

export interface RunQueryInput {
	readonly connectionId: string;
	readonly source: string;
	/** Si présent, appelle la route team-scoped ; sinon la route legacy
	 *  (transitionnel). */
	readonly teamSlug?: string | null;
}

export async function runQueryRequest(input: RunQueryInput): Promise<QueryResult> {
	// Table système SQLNest — routée backend interne. Le tunnel proxy ne
	// touche jamais la DB user pour ces kinds. Aujourd'hui : `list
	// schema_events` (audit trail `canvas_checksum_event`). Détection via
	// parser SNQL — plus de regex intercept fragile.
	const introspect = detectSqlnestIntrospect(input.source);
	if (introspect?.kind === "schema-events") {
		const page = await fetchChecksumHistory(
			input.connectionId,
			input.teamSlug ?? null,
			// Fetch un batch large (max endpoint) puis matérialisation
			// client-side des stages SNQL en dessous. Pushdown vrai (cursor
			// keyset traduit depuis where/limit) = v-next.
			{ limit: 100 }
		);
		// Canvas pas encore synchronisé (heartbeat CLI n'a pas capté cette
		// connexion) → table vide, cohérent avec "aucun événement". Pas d'erreur.
		const base = schemaEventsToQueryResult(page?.entries ?? []);
		if (
			introspect.postOps === undefined ||
			introspect.postOps.length === 0
		) {
			return base;
		}
		// Matérialisation client-side : `where` / `pick` / `sort` / `limit` du
		// pipeline SNQL appliqués sur les rows retournées via `compensate`
		// (référence sémantique 3VL du cœur).
		const compensated = compensate(
			introspect.postOps,
			base.rows as readonly Row[]
		);
		return {
			...base,
			rows: compensated,
			rowCount: compensated.length
		};
	}

	const url = input.teamSlug
		? `${API_BASE}/api/teams/${encodeURIComponent(input.teamSlug)}/db-connections/${encodeURIComponent(input.connectionId)}/query`
		: `${API_BASE}/api/db-connections/${encodeURIComponent(input.connectionId)}/query`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		credentials: "include",
		body: JSON.stringify({ source: input.source })
	});
	const data = (await res.json().catch(() => ({}))) as QueryResult & {
		message?: string;
		pgError?: PgErrorInfo;
	};
	if (!res.ok) {
		throw new SnqlRuntimeError(
			data.message ?? `Erreur HTTP ${res.status}`,
			data.pgError
		);
	}
	return data;
}

/**
 * Exécute une requête SNQL via le proxy tunnel
 * `POST /api/db-connections/:id/query`. Le moteur (postgres / mongodb) est
 * porté par la connection elle-même — plus besoin de le passer ici.
 */
export function useRunQuery() {
	return useMutation({ mutationFn: runQueryRequest });
}
