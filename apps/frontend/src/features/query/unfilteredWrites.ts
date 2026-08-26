/**
 * Walker AST — collecte les écritures non filtrées (unfiltered writes) d'un
 * Statement SNQL. Couvre les variantes AST via récursion Transaction /
 * Savepoint / Let, sans re-inventer la traversée.
 *
 * Ce qui est détecté :
 *  - `unfiltered_update` — UpdateStatement sans `.predicate` racine (peu importe
 *    `.joins` — un `update t with one X on l=f set …` sans predicate reste
 *    unfiltered pour la table cible t).
 *  - `unfiltered_delete` — DeleteStatement sans `.predicate`.
 *  - `bulk_copy_insert` — InsertStatement avec `.sourceQuery` dont aucun stage
 *    n'est un `where` (`add (find users pick *) into archive` copie toute
 *    la source, warn distinct du bucket unfiltered).
 *  - `raw_opaque` — tout RawStatement (le payload SQL/Mongo est opaque au
 *    parser, warn systématique).
 *
 * Ce qui n'est PAS détecté (intentionnel) :
 *  - `OnConflictClause.action.where` — un upsert `add {…} into t on
 *    conflict (id) edit set x = new.x` SANS where global est normal : les
 *    keys de conflit bornent déjà le sous-set. Le walker IGNORE ce where.
 *  - Les CTE bindings d'un `let` (`.bindings[].query`) — read-only par
 *    contrat lower (writes refusés au lower `lower_let_write_in_cte`).
 *  - Les predicates tautologiques (`where 1 = 1`) — l'user assume.
 *    Documenté comme limite dans le tooltip du badge safe mode.
 *  - Un InsertStatement avec `.rows` (documents littéraux) sans sourceQuery :
 *    le count est borné par le nombre de rows tapées, pas wipe-scale.
 *
 * Récursion :
 *  - Transaction → body[] (Query|Insert|Update|Delete|Savepoint)
 *  - Savepoint → body[] récursif (savepoint dans savepoint autorisé au parse)
 *  - Let → .body single (Query|Insert|Update|Delete — pas Transaction, refusé
 *    au parse, verrouillé par test unitaire au cas où l'union s'élargit)
 *  - Savepoint racine (standalone) traité comme si dans une tx implicite
 *    (l'user compose sa tx en tapant les savepoints d'abord, doit voir le
 *    warning en construction — même si le lower refuse l'exec)
 *
 * Fonction pure — pas d'I/O, pas de state global, pas de mutation. Testable
 * en isolation, réutilisable dans le gate `execute()`, dans l'autorun
 * guard, et dans le live diagnostic.
 */

import type {
	DeleteStatement,
	InsertStatement,
	Query,
	SavepointStatement,
	Span,
	Statement,
	TransactionBodyItem,
	TransactionStatement,
	UpdateStatement
} from "@sqlnest/snql";

/** Kind discriminant — chaque bucket a un label + severity distincts en UI. */
export type UnfilteredKind =
	| "unfiltered_update"
	| "unfiltered_delete"
	| "bulk_copy_insert"
	| "raw_opaque"
	// DDL Tier-2 destructive (ADR-029 D7). `drop table` / `drop column` /
	// `drop index` — WriteConfirmBar gate typing "Tape DROP <target>". Les
	// 3 kinds partagent le même UnfilteredKind pour un traitement UI
	// uniforme (target = table pour drop-table/drop-column, index name pour
	// drop-index).
	| "destructive_drop";

/**
 * Un finding = un span source (ancre pour squiggly/tooltip) + son kind (pour
 * choisir label + severity) + le verbe tel qu'écrit par l'user + la cible
 * (nom collection). Les 2 derniers permettent au TextInput de calculer la
 * string exacte à retaper (`REMOVE FROM users`).
 */
export interface UnfilteredFinding {
	readonly span: Span;
	readonly kind: UnfilteredKind;
	readonly verb: string;
	readonly target: string;
}

/**
 * Descend le statement et retourne TOUS les writes non filtrés découverts,
 * dans l'ordre d'apparition (utile pour lister par ligne). Un
 * `transaction { remove from users; remove from orders }` retourne 2
 * findings distincts, pas un warning global.
 */
export function collectUnfilteredWrites(stmt: Statement): UnfilteredFinding[] {
	const out: UnfilteredFinding[] = [];
	walk(stmt, out);
	return out;
}

function walk(stmt: Statement, out: UnfilteredFinding[]): void {
	switch (stmt.operation) {
		case "select":
		case "introspect":
			return;
		case "update":
			checkUpdate(stmt, out);
			return;
		case "delete":
			checkDelete(stmt, out);
			return;
		case "insert":
			checkInsert(stmt, out);
			return;
		case "raw":
			// Payload opaque au parser — warn systématique.
			out.push({
				span: stmt.span,
				kind: "raw_opaque",
				verb: "raw",
				// La cible d'un raw n'est pas connue au niveau AST (SQL brut opaque
				// pour PG, command doc pour Mongo). Le TextInput demandera au
				// user de retaper le mot "RAW" seul comme confirmation.
				target: "RAW"
			});
			return;
		case "transaction":
			walkBody(stmt.body, out);
			return;
		case "savepoint":
			// Le walker se déclenche AUSSI sur savepoint racine standalone
			// (usage typique : composer une tx en tapant d'abord les
			// savepoints — le user doit voir le warning en construction).
			walkBody(stmt.body, out);
			return;
		case "let":
			walkLetBody(stmt.body, out);
			return;
		case "ddl":
			// DDL Tier-2 (ADR-029). `create-table` / `add-column` /
			// `add-index` / `add-unique-index` / `create-enum` /
			// `add-enum-member` = non-destructifs (pass-through V1).
			// `drop-table` / `drop-column` / `drop-index` / `drop-enum` (ADR-030
			// Enum/3 D8) = destructifs D7 → typing UI gate WriteConfirmBar "Tape
			// DROP <target> pour confirmer".
			if (
				stmt.kind === "drop-table" ||
				stmt.kind === "drop-column" ||
				stmt.kind === "drop-index" ||
				stmt.kind === "drop-enum"
			) {
				// target = table pour drop-table/drop-column, name pour drop-index
				// et drop-enum (l'user retape ce qu'il voit dans son SNQL).
				const dropTarget =
					stmt.kind === "drop-index" || stmt.kind === "drop-enum"
						? stmt.name
						: stmt.target;
				out.push({
					span: stmt.span,
					kind: "destructive_drop",
					verb: "drop",
					target: dropTarget
				});
			}
			return;
	}
}

function walkBody(body: readonly TransactionBodyItem[], out: UnfilteredFinding[]): void {
	for (const item of body) {
		switch (item.operation) {
			case "select":
				continue;
			case "insert":
				checkInsert(item, out);
				continue;
			case "update":
				checkUpdate(item, out);
				continue;
			case "delete":
				checkDelete(item, out);
				continue;
			case "savepoint":
				walkBody(item.body, out);
				continue;
		}
	}
}

/**
 * Le body d'un LetStatement est étroitement typé : Query | Insert | Update |
 * Delete (Transaction/Savepoint/Raw/Introspect/Let refusés au parser). On
 * dispatche à la main sans fallthrough vers `walk()` — évite d'ouvrir
 * la porte à des cas impossibles qui masqueraient une régression AST future.
 * Un test unitaire dédié verrouille ce contrat (voir unfilteredWrites.test.ts).
 */
function walkLetBody(
	body: Query | InsertStatement | UpdateStatement | DeleteStatement,
	out: UnfilteredFinding[]
): void {
	switch (body.operation) {
		case "select":
			return;
		case "insert":
			checkInsert(body, out);
			return;
		case "update":
			checkUpdate(body, out);
			return;
		case "delete":
			checkDelete(body, out);
			return;
	}
}

function checkUpdate(stmt: UpdateStatement, out: UnfilteredFinding[]): void {
	// La présence de `.joins` ne compte PAS comme filter — un `update t
	// with one X on l=f set …` sans .predicate reste unfiltered pour la
	// table cible t (INNER JOIN qui match tout ≠ filter). Le lower refuse
	// déjà `with many` donc la surface est bornée à 1-to-1/many-to-one.
	if (stmt.predicate === undefined) {
		out.push({
			span: stmt.span,
			kind: "unfiltered_update",
			verb: stmt.verb,
			target: stmt.collection
		});
	}
}

function checkDelete(stmt: DeleteStatement, out: UnfilteredFinding[]): void {
	if (stmt.predicate === undefined) {
		out.push({
			span: stmt.span,
			kind: "unfiltered_delete",
			verb: stmt.verb,
			target: stmt.collection
		});
	}
}

function checkInsert(stmt: InsertStatement, out: UnfilteredFinding[]): void {
	// Bulk-copy = insert-select dont le SELECT sous-jacent n'a aucun
	// stage `where`. Copier toute users vers archive = doubling data à
	// grande échelle. Séparé du bucket unfiltered pour distinguer
	// destructif vs massif. Le where éventuel de stmt.onConflict.action
	// est IGNORÉ — c'est un filtre partiel sur les rows en conflit, pas
	// un filtre unfiltered.
	if (stmt.sourceQuery !== undefined && !hasWhereStage(stmt.sourceQuery)) {
		out.push({
			span: stmt.span,
			kind: "bulk_copy_insert",
			verb: stmt.verb,
			target: stmt.collection
		});
	}
}

function hasWhereStage(query: Query): boolean {
	for (const stage of query.stages) {
		if (stage.type === "where") return true;
	}
	return false;
}

/**
 * Utilitaire d'exposition — permet au ConsoleShellInner (gate execute) et
 * au route autorun de tester rapidement "y a-t-il au moins un write
 * dangereux" sans allouer un tableau si non nécessaire.
 */
export function hasAnyUnfilteredWrite(stmt: Statement): boolean {
	return collectUnfilteredWrites(stmt).length > 0;
}

/**
 * Label court pour la squiggly + tooltip. Cohérent
 * [[feedback-no-ai-slop-labels]] — terse, actionnable, français.
 */
export function labelForFinding(finding: UnfilteredFinding): string {
	switch (finding.kind) {
		case "unfiltered_update":
			return `Écriture non filtrée — touche toutes les lignes de ${finding.target}`;
		case "unfiltered_delete":
			return `Suppression non filtrée — touche toutes les lignes de ${finding.target}`;
		case "bulk_copy_insert":
			return `Copie massive — copie l'intégralité de la source dans ${finding.target}`;
		case "raw_opaque":
			return "Raw query — non analysable, aucun garde-fou AST";
		case "destructive_drop":
			return `Drop destructif — supprime ${finding.target}`;
	}
}

/** Types re-exportés pour éviter que les consumers importent depuis @sqlnest/snql
 * pour un simple type utilitaire (Span est un shape stable, pas un couplage). */
export type { Span, Statement } from "@sqlnest/snql";
