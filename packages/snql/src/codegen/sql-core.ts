import { SnqlError } from "../diagnostics";
import { SNQL_FUNCTIONS } from "../functions";
import type {
	CastTarget,
	CompareOp,
	LogicalPlan,
	MutationPlan,
	PlanExpr,
	PlanProjectField,
	PlanSortKey,
	SqlValue,
	TransactionPlanItem
} from "../ir/plan";
import { isSqlDecimal, linearize } from "../ir/plan";
import type { Span } from "../lexer/token";
import type { SerializedSpan, SqlQuery, SqlTransactionStep } from "./mapper";

/**
 * Noyau de codegen SQL partagé — la mécanique commune aux mappers SQL
 * (Postgres, MSSQL) : linearize → absorb/materialize en SELECTs imbriqués,
 * ParamList positionnelle, renderExpr récursif, joins embed/left/count.
 *
 * Les points de divergence entre dialectes (quoting, forme des paramètres,
 * pagination, agrégation JSON des embeds, casts, littéraux booléens…) passent
 * par `SqlDialect` — chaque mapper fournit le sien et récupère un renderer
 * complet via `createSqlRenderer`. Extraction faite au 2e consommateur
 * (chantier MSSQL M/3) : le comportement PG est la référence, à l'identique.
 */

export interface SqlDialect {
	/** Nom d'engine — stamped sur les NativeQuery et utilisé pour le lookup
	 *  des renderers de fonctions du registre (`entry.engines[<engine>]`). */
	readonly engine: string;
	/** Wrap d'un identifiant DÉJÀ validé par IDENT_RE (`"x"` PG, `[x]` T-SQL). */
	wrapIdent(name: string): string;
	/** Référence positionnelle du paramètre i (1-based) : `$3` PG, `@p3` T-SQL. */
	paramRef(index: number): string;
	/** Littéral booléen utilisable en contexte prédicat (`FALSE` PG, `(1 = 0)`
	 *  T-SQL qui n'a pas de type booléen en expression). */
	falseLiteral(): string;
	/**
	 * Annotation de type d'un paramètre bindé quand le contexte l'exige
	 * (littéraux décimaux en arithmétique, valeurs de json builders…).
	 * PG : `$N::numeric` ; T-SQL : `CAST(@pN AS decimal(38,10))`.
	 */
	typedParam(ref: string, kind: TypedParamKind): string;
	/** Type SQL cible d'un `cast(x as T)` canonique, ou undefined si le
	 *  target n'est pas un builtin (enum-ref → ident quoted par l'appelant). */
	castType(target: CastTarget): string | undefined;
	/** Agrégat JSON d'un embed one-to-many : le SELECT corrélé complet
	 *  (PG `json_agg`, T-SQL `FOR JSON PATH`). */
	embedAgg(args: {
		readonly innerRef: string;
		readonly fromClause: string;
		readonly correlation: string;
	}): string;
	/** Objet JSON d'une row jointe entière (`pick alias` sur un join) :
	 *  PG `row_to_json(alias)`, T-SQL sous-requête `FOR JSON PATH,
	 *  WITHOUT_ARRAY_WRAPPER`. */
	rowObject(aliasSql: string): string;
	/** Builder d'objet JSON literal (`{k: v}`) — les parts alternent
	 *  key/value déjà rendues. PG `jsonb_build_object(...)`. */
	jsonObject(parts: readonly string[]): string;
	/** Builder d'array JSON literal (`[a, b]`). PG `jsonb_build_array(...)`. */
	jsonArray(parts: readonly string[]): string;
	/**
	 * Stratégie DISTINCT ON : `native` émet `SELECT DISTINCT ON (keys)` (PG) ;
	 * `row-number` fait wrapper le SELECT par le core dans un
	 * `ROW_NUMBER() OVER (PARTITION BY keys ORDER BY …) = 1` (T-SQL) — la
	 * colonne technique `__sqlnest_rn` est retirée du ResultSet par l'adapter.
	 */
	readonly distinctOnStrategy: "native" | "row-number";
	/**
	 * Fragments de pagination. PG renvoie `afterOrder: "LIMIT $n [OFFSET $m]"`.
	 * T-SQL : `TOP (@pN)` en `selectPrefixSuffix` sans offset ; avec offset,
	 * `OFFSET @pM ROWS FETCH NEXT @pN ROWS ONLY` en `afterOrder` +
	 * `forcedOrderBy` (`(SELECT NULL)`) quand le SELECT n'a pas d'ORDER BY
	 * (OFFSET-FETCH l'exige).
	 */
	limitFragments(args: {
		readonly limitRef: string;
		readonly offsetRef: string | undefined;
		readonly hasOrderBy: boolean;
	}): {
		readonly selectPrefixSuffix?: string;
		readonly afterOrder?: string;
		readonly forcedOrderBy?: string;
	};
	/** Référence de la row proposée dans un upsert (`new.<col>`) : PG
	 *  `EXCLUDED."col"`. Les dialectes sans upsert pushdown (MSSQL M/3)
	 *  throw ici — le planner gate déjà via capabilities. */
	upsertNewRef(columnSql: string): string;
	/**
	 * Notifié pour chaque colonne du résultat dont la valeur est du JSON
	 * produit par le codegen (embed one-to-many, objet de row jointe) — les
	 * dialectes sans type json natif (T-SQL) collectent ces alias dans
	 * `SqlQuery.jsonColumns` pour que l'adapter parse les strings. PG :
	 * absent (le driver parse json/jsonb nativement).
	 */
	onJsonColumn?(alias: string): void;
}

/** Contexte de typage d'un paramètre pour `SqlDialect.typedParam`. */
export type TypedParamKind =
	| "text"
	| "bool"
	| "bigint"
	| "float"
	| "numeric"
	| "json";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Colonne technique du wrap DISTINCT ON en stratégie row-number — l'adapter
 *  du dialecte concerné la retire du ResultSet. */
export const DISTINCT_ON_RN_COLUMN = "__sqlnest_rn";

const COMPARE_SQL: Readonly<Record<CompareOp, string>> = {
	eq: "=",
	ne: "<>",
	lt: "<",
	gt: ">",
	le: "<=",
	ge: ">=",
	like: "LIKE"
};

// Phases = ordre d'évaluation logique d'un SELECT. Une étape ne peut rejoindre le
// SELECT courant que si sa phase ne « recule » pas (et si son slot est libre).
// ordre canonique SNQL aligné SQL évaluation :
// with(join) → where(filter) → group → having → pick(project) → sort → limit.
// Cela permet à sort de référencer les alias du pick (comme ORDER BY après SELECT en SQL).
const PHASE = {
	filter: 1,
	join: 2,
	group: 3,
	having: 4,
	project: 5,
	sort: 6,
	limit: 7
} as const;

interface JoinSpec {
	readonly collection: string;
	readonly as: string;
	readonly localField: readonly string[];
	readonly foreignField: readonly string[];
	readonly innerAlias: string; // alias de la table interne (évite le shadowing en self-join)
	/**
	 * `embed` : agrégat JSON corrélé — l'alias devient un tableau JSON dans la
	 *   sortie (one-to-many). Les refs `alias.field` en pick/where ne sont pas
	 *   résolvables.
	 * `join` : LEFT JOIN classique — l'alias est une vraie source SQL, ses colonnes
	 *   sont projetables et filtrables. `pick alias` seul rend un objet unique.
	 * `count` : reverse-nav agrégé (ADR-031 D7) — l'alias est un SCALAIRE = count
	 *   corrélé des lignes droites, via `(SELECT count(*) …)`.
	 */
	readonly kind: "embed" | "join" | "count";
}

interface Select {
	from: string;
	base: string; // référence pour qualifier les champs (alias ou nom de collection)
	where: PlanExpr[];
	joins: JoinSpec[];
	project: readonly PlanProjectField[] | null;
	// GROUP BY / HAVING slots. Peuplés quand un aggregate op est
	// absorbé et qu'il porte des groupKeys/having. Null par défaut.
	groupKeys: readonly (readonly string[])[] | null;
	having: PlanExpr | null;
	// DISTINCT / DISTINCT ON.
	distinct: boolean;
	distinctOnKeys: readonly (readonly string[])[] | null;
	order: readonly PlanSortKey[] | null;
	limit: number | null;
	offset: number | null;
	maxPhase: number;
}

/**
 * Aplatis un body de TransactionPlan en steps SqlTransaction (statements
 * pré-rendus + directives savepoint). Partagé PG/MSSQL — chaque dialecte
 * fournit ses renderers read/write (chaque statement porte sa propre
 * ParamList, les placeholders sont scopés au statement).
 */
export function buildSqlTransactionSteps(
	body: readonly TransactionPlanItem[],
	render: {
		readonly renderRead: (plan: LogicalPlan) => SqlQuery;
		readonly renderWrite: (plan: MutationPlan) => SqlQuery;
	}
): SqlTransactionStep[] {
	const out: SqlTransactionStep[] = [];
	const walk = (items: readonly TransactionPlanItem[]): void => {
		for (const item of items) {
			if (item.kind === "read") {
				out.push({ kind: "statement", query: render.renderRead(item.plan) });
			} else if (item.kind === "write") {
				out.push({ kind: "statement", query: render.renderWrite(item.plan) });
			} else {
				out.push({ kind: "savepoint-begin", name: item.name });
				walk(item.body);
				out.push({ kind: "savepoint-release", name: item.name });
			}
		}
	};
	walk(body);
	return out;
}

/** Liste de paramètres positionnels — la forme du placeholder vient du dialecte. */
export class ParamList {
	private readonly values: unknown[] = [];
	private readonly spans: (SerializedSpan | undefined)[] = [];
	readonly #dialect: SqlDialect;

	constructor(dialect: SqlDialect) {
		this.#dialect = dialect;
	}

	add(value: SqlValue, span?: Span): string {
		// Un décimal exact est bindé comme texte : l'engine SQL le caste vers le
		// type de la colonne cible via l'inférence par colonne pour les
		// INSERT/UPDATE/comparaisons. Le cast explicite n'est appliqué que dans
		// un contexte arithmétique — cf. `renderArithOperand` — sinon il casse
		// les colonnes non-numeric (`WHERE varchar_col = 1.5`).
		this.values.push(isSqlDecimal(value) ? value.raw : value);
		this.spans.push(
			span !== undefined
				? [span.start.offset, span.end.offset - span.start.offset]
				: undefined
		);
		return this.#dialect.paramRef(this.values.length);
	}

	all(): readonly unknown[] {
		return this.values;
	}

	allSpans(): readonly (SerializedSpan | undefined)[] {
		return this.spans;
	}
}

/**
 * Renderer SQL complet pour un dialecte. Pur — chaque méthode reçoit la
 * ParamList du statement en cours (les placeholders sont positionnels et
 * scopés au statement).
 */
export interface SqlRenderer {
	readonly dialect: SqlDialect;
	newParams(): ParamList;
	quoteIdent(name: string): string;
	renderPlan(plan: LogicalPlan, params: ParamList): string;
	renderExpr(expr: PlanExpr, params: ParamList): string;
	renderProjection(field: PlanProjectField, params: ParamList): string;
	renderSortKey(key: PlanSortKey): string;
	renderPath(path: readonly string[]): string;
	/** Path d'une clé de join mutation : col bare → préfixée par l'alias. */
	renderJoinPath(path: readonly string[], alias: string): string;
}

export function createSqlRenderer(dialect: SqlDialect): SqlRenderer {
	function quoteIdent(name: string): string {
		if (!IDENT_RE.test(name)) {
			throw new SnqlError(
				`Identifiant invalide '${name}'`,
				"codegen_invalid_ident"
			);
		}
		return dialect.wrapIdent(name);
	}

	function renderPath(path: readonly string[]): string {
		return path.map(quoteIdent).join(".");
	}

	function renderJoinPath(path: readonly string[], alias: string): string {
		if (path.length === 1) return `${quoteIdent(alias)}.${quoteIdent(path[0]!)}`;
		return renderPath(path);
	}

	function renderSortKey(key: PlanSortKey): string {
		return `${renderPath(key.path)} ${key.direction === "desc" ? "DESC" : "ASC"}`;
	}

	function renderFrom(collection: string, alias: string | undefined): string {
		const table = quoteIdent(collection);
		return alias !== undefined ? `${table} AS ${quoteIdent(alias)}` : table;
	}

	function qualify(ref: string, path: readonly string[]): string {
		return `${quoteIdent(ref)}.${path.map(quoteIdent).join(".")}`;
	}

	function renderPlan(plan: LogicalPlan, params: ParamList): string {
		const ops = linearize(plan);
		const scan = ops[0];
		if (scan === undefined || scan.op !== "scan") {
			throw new SnqlError(
				"Plan sans collection source (scan manquant)",
				"codegen_no_scan"
			);
		}

		let current = emptySelect(
			renderFrom(scan.collection, scan.alias),
			scan.alias ?? scan.collection
		);
		let depth = 0;
		for (let i = 1; i < ops.length; i += 1) {
			const op = ops[i];
			if (op === undefined) {
				continue;
			}
			if (!canAbsorb(current, op)) {
				const inner = renderSelect(current, params);
				const alias = `t${depth}`;
				current = emptySelect(`(${inner}) AS ${quoteIdent(alias)}`, alias);
				depth += 1;
			}
			absorb(current, op);
		}
		return renderSelect(current, params);
	}

	function emptySelect(from: string, base: string): Select {
		return {
			from,
			base,
			where: [],
			joins: [],
			project: null,
			groupKeys: null,
			having: null,
			distinct: false,
			distinctOnKeys: null,
			order: null,
			limit: null,
			offset: null,
			maxPhase: 0
		};
	}

	function canAbsorb(sel: Select, op: LogicalPlan): boolean {
		switch (op.op) {
			case "scan":
				return false;
			case "filter":
				// Un WHERE après un LEFT JOIN est standard SQL — pas besoin de matérialiser
				// tant que les joins déjà absorbés sont tous `kind: "join"`. Un embed
				// JSON reste dans la SELECT-list, on ne peut pas WHERE dessus.
				return (
					sel.maxPhase <= PHASE.filter ||
					sel.joins.every((j) => j.kind === "join")
				);
			case "join":
				return sel.maxPhase <= PHASE.join;
			case "project":
			case "aggregate":
				// La SELECT-list est indépendante de WHERE/ORDER BY/LIMIT : un `project`
				// (ou `aggregate` même slot mutex) peut rejoindre le SELECT
				// courant tant que son slot est libre. Le SQL accepte SELECT agg FROM t
				// sans GROUP BY natif (implicit grouping) → zero refactor.
				return sel.project === null;
			case "sort":
				return sel.order === null && sel.maxPhase <= PHASE.sort;
			case "limit":
				return sel.limit === null && sel.offset === null;
		}
	}

	function absorb(sel: Select, op: LogicalPlan): void {
		switch (op.op) {
			case "scan":
				return;
			case "filter":
				sel.where.push(op.predicate);
				sel.maxPhase = Math.max(sel.maxPhase, PHASE.filter);
				return;
			case "join":
				sel.joins.push({
					collection: op.collection,
					as: op.as,
					localField: op.localField,
					foreignField: op.foreignField,
					innerAlias: `__j${sel.joins.length}`,
					kind: op.kind
				});
				sel.maxPhase = Math.max(sel.maxPhase, PHASE.join);
				return;
			case "project":
				sel.project = op.fields;
				// DISTINCT / DISTINCT ON absorbés dans le SELECT.
				if (op.unique === true) sel.distinct = true;
				if (op.distinctOnKeys !== undefined) sel.distinctOnKeys = op.distinctOnKeys;
				sel.maxPhase = Math.max(sel.maxPhase, PHASE.project);
				return;
			case "aggregate":
				// aggregate rend une SELECT-list comme project
				// (implicit grouping sans GROUP BY quand aucun field bare).
				// GROUP BY explicit quand op.groupKeys non-empty;
				// HAVING quand op.having présent.
				sel.project = op.fields;
				if (op.groupKeys !== undefined) {
					sel.groupKeys = op.groupKeys;
					sel.maxPhase = Math.max(sel.maxPhase, PHASE.group);
				}
				if (op.having !== undefined) {
					sel.having = op.having;
					sel.maxPhase = Math.max(sel.maxPhase, PHASE.having);
				}
				sel.maxPhase = Math.max(sel.maxPhase, PHASE.project);
				return;
			case "sort":
				sel.order = op.keys;
				sel.maxPhase = Math.max(sel.maxPhase, PHASE.sort);
				return;
			case "limit":
				sel.limit = op.count;
				sel.offset = op.offset ?? null;
				sel.maxPhase = Math.max(sel.maxPhase, PHASE.limit);
				return;
		}
	}

	function renderSelect(sel: Select, params: ParamList): string {
		// DISTINCT ON en stratégie row-number : rendre le SELECT sans le
		// distinct-on ni sort/pagination, puis wrapper — la row gardée par
		// partition est la première selon l'ORDER BY (sémantique PG DISTINCT ON,
		// NULL keys groupés ensemble via PARTITION BY).
		if (
			sel.distinctOnKeys !== null &&
			sel.distinctOnKeys.length > 0 &&
			dialect.distinctOnStrategy === "row-number"
		) {
			return renderDistinctOnRowNumber(sel, params);
		}
		let selectPrefix = "SELECT";
		if (
			sel.distinctOnKeys !== null &&
			sel.distinctOnKeys.length > 0 &&
			dialect.distinctOnStrategy === "native"
		) {
			selectPrefix = `SELECT DISTINCT ON (${sel.distinctOnKeys.map((k) => renderPath(k)).join(", ")})`;
		} else if (sel.distinct) {
			selectPrefix = "SELECT DISTINCT";
		}

		// Rendu dans l'ordre positionnel HISTORIQUE des params : SELECT-list →
		// WHERE → HAVING → pagination en dernier. Le bind est par index, pas par
		// position dans le texte — un `TOP (@p5)` en tête de texte reste valide.
		const selectList = renderSelectList(sel, params);
		const leftJoins: string[] = [];
		// Les joins `kind: "join"` sont matérialisés en LEFT JOIN — leurs colonnes
		// sont directement projetables/filtrables. Les `embed` restent des sous-
		// requêtes JSON tirées dans la SELECT-list.
		for (const join of sel.joins) {
			if (join.kind === "join") {
				leftJoins.push(renderLeftJoin(join, sel.base));
			}
		}
		const whereSql = sel.where.length > 0
			? `WHERE ${sel.where.map((f) => renderExpr(f, params)).join(" AND ")}`
			: undefined;
		const groupSql = sel.groupKeys && sel.groupKeys.length > 0
			? `GROUP BY ${sel.groupKeys.map((k) => renderPath(k)).join(", ")}`
			: undefined;
		const havingSql = sel.having
			? `HAVING ${renderExpr(sel.having, params)}`
			: undefined;
		const orderSql = sel.order && sel.order.length > 0
			? `ORDER BY ${sel.order.map(renderSortKey).join(", ")}`
			: undefined;
		const limitFragments = paginationFragments(
			sel.limit,
			sel.offset,
			orderSql !== undefined,
			params
		);
		if (limitFragments?.selectPrefixSuffix !== undefined) {
			selectPrefix = `${selectPrefix} ${limitFragments.selectPrefixSuffix}`;
		}

		const parts: string[] = [
			`${selectPrefix} ${selectList}`,
			`FROM ${sel.from}`,
			...leftJoins
		];
		if (whereSql !== undefined) parts.push(whereSql);
		if (groupSql !== undefined) parts.push(groupSql);
		if (havingSql !== undefined) parts.push(havingSql);
		if (orderSql !== undefined) {
			parts.push(orderSql);
		} else if (limitFragments?.forcedOrderBy !== undefined) {
			parts.push(`ORDER BY ${limitFragments.forcedOrderBy}`);
		}
		if (limitFragments?.afterOrder !== undefined) {
			parts.push(limitFragments.afterOrder);
		}
		return parts.join(" ");
	}

	/**
	 * Fragments de pagination du dialecte, ou undefined sans limit/offset.
	 * Les refs params sont créées ici, dans l'ordre positionnel historique
	 * (limit puis offset) — appeler AVANT de binder d'autres valeurs
	 * postérieures dans le même SELECT.
	 */
	function paginationFragments(
		limit: number | null,
		offset: number | null,
		hasOrderBy: boolean,
		params: ParamList
	): ReturnType<SqlDialect["limitFragments"]> | undefined {
		if (limit === null && offset === null) return undefined;
		const limitRef = limit !== null ? params.add(limit) : "";
		const offsetRef = offset !== null ? params.add(offset) : undefined;
		return dialect.limitFragments({ limitRef, offsetRef, hasOrderBy });
	}

	/**
	 * DISTINCT ON via ROW_NUMBER (dialectes sans DISTINCT ON natif) :
	 * `SELECT … , ROW_NUMBER() OVER (PARTITION BY keys ORDER BY <sort|keys>)
	 * AS __sqlnest_rn` wrappé d'un `WHERE __sqlnest_rn = 1`. Le sort et la
	 * pagination du SELECT source s'appliquent au wrapper EXTERNE (ordre des
	 * résultats), l'ORDER BY de l'OVER décide de la row gardée (miroir PG :
	 * ORDER BY commence par les keys, NULL keys groupés par PARTITION BY). La
	 * colonne technique est retirée du ResultSet par l'adapter (contrat
	 * DISTINCT_ON_RN_COLUMN).
	 */
	function renderDistinctOnRowNumber(sel: Select, params: ParamList): string {
		const keys = sel.distinctOnKeys ?? [];
		const partition = keys.map((k) => renderPath(k)).join(", ");
		const overOrder = sel.order !== null && sel.order.length > 0
			? sel.order.map(renderSortKey).join(", ")
			: keys.map((k) => renderPath(k)).join(", ");
		const rn = `ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${overOrder}) AS ${quoteIdent(DISTINCT_ON_RN_COLUMN)}`;

		// SELECT interne : list originale + colonne rn ; sans sort/pagination
		// (déplacés à l'externe).
		const innerSel: Select = {
			...sel,
			distinctOnKeys: null,
			order: null,
			limit: null,
			offset: null
		};
		const innerList = renderSelectList(innerSel, params);
		const innerParts: string[] = [
			`SELECT ${innerList}, ${rn}`,
			`FROM ${sel.from}`
		];
		for (const join of sel.joins) {
			if (join.kind === "join") {
				innerParts.push(renderLeftJoin(join, sel.base));
			}
		}
		if (sel.where.length > 0) {
			innerParts.push(
				`WHERE ${sel.where.map((f) => renderExpr(f, params)).join(" AND ")}`
			);
		}
		if (sel.groupKeys && sel.groupKeys.length > 0) {
			innerParts.push(
				`GROUP BY ${sel.groupKeys.map((k) => renderPath(k)).join(", ")}`
			);
		}
		if (sel.having) {
			innerParts.push(`HAVING ${renderExpr(sel.having, params)}`);
		}

		// Wrapper externe explicite : filtre rn = 1, puis ordre/pagination
		// d'origine (le dialecte fournit ses fragments comme pour tout SELECT).
		const hasOrderBy = sel.order !== null && sel.order.length > 0;
		const limitFragments = paginationFragments(
			sel.limit,
			sel.offset,
			hasOrderBy,
			params
		);
		let outerPrefix = "SELECT";
		if (limitFragments?.selectPrefixSuffix !== undefined) {
			outerPrefix = `${outerPrefix} ${limitFragments.selectPrefixSuffix}`;
		}
		const outerParts: string[] = [
			`${outerPrefix} *`,
			`FROM (${innerParts.join(" ")}) AS ${quoteIdent("__sqlnest_don")}`,
			`WHERE ${quoteIdent(DISTINCT_ON_RN_COLUMN)} = 1`
		];
		if (hasOrderBy && sel.order !== null) {
			outerParts.push(`ORDER BY ${sel.order.map(renderSortKey).join(", ")}`);
		} else if (limitFragments?.forcedOrderBy !== undefined) {
			outerParts.push(`ORDER BY ${limitFragments.forcedOrderBy}`);
		}
		if (limitFragments?.afterOrder !== undefined) {
			outerParts.push(limitFragments.afterOrder);
		}
		return outerParts.join(" ");
	}

	function renderSelectList(sel: Select, params: ParamList): string {
		if (sel.project) {
			return sel.project
				.map((field) => renderProjectField(field, sel, params))
				.join(", ");
		}
		if (sel.joins.length > 0) {
			const columns = [`${quoteIdent(sel.base)}.*`];
			for (const join of sel.joins) {
				if (join.kind !== "count") dialect.onJsonColumn?.(join.as);
				columns.push(
					`${renderJoinAliasSource(join, sel.base)} AS ${quoteIdent(join.as)}`
				);
			}
			return columns.join(", ");
		}
		return "*";
	}

	/**
	 * Un champ projeté qui pointe vers un alias de join `embed` devient sa sous-
	 * requête d'agrégat JSON. Pour un `join`, si l'utilisateur pointe l'alias
	 * entier (`pick x`), on retourne l'objet row entier pour homogénéiser avec
	 * l'embed (un seul champ = un objet). Sinon, un chemin qualifié `alias.field`
	 * traverse naturellement le LEFT JOIN et devient une ref SQL directe.
	 */
	function renderProjectField(
		field: PlanProjectField,
		sel: Select,
		params: ParamList
	): string {
		if (field.path.length === 1) {
			const join = sel.joins.find((candidate) => candidate.as === field.path[0]);
			if (join !== undefined) {
				if (join.kind !== "count") {
					dialect.onJsonColumn?.(field.alias ?? join.as);
				}
				return `${renderJoinAliasSource(join, sel.base)} AS ${quoteIdent(field.alias ?? join.as)}`;
			}
		}
		return renderProjection(field, params);
	}

	/**
	 * Source SQL de l'alias d'un join projeté ou sélectionné en globalité :
	 *  - `embed` → sous-requête d'agrégat JSON corrélée ;
	 *  - `join`  → objet JSON de la row jointe (dialecte) ;
	 *  - `count` → count corrélé scalaire.
	 */
	function renderJoinAliasSource(join: JoinSpec, base: string): string {
		if (join.kind === "embed") {
			return renderEmbedSubquery(join, base);
		}
		if (join.kind === "count") {
			return renderCountSubquery(join, base);
		}
		// LEFT JOIN déjà émis dans le FROM — on projette juste l'objet.
		return dialect.rowObject(quoteIdent(join.as));
	}

	/** Reverse-nav (ADR-031 D7) : count corrélé des lignes droites matchées. */
	function renderCountSubquery(join: JoinSpec, base: string): string {
		const selfJoin = join.collection === base;
		const innerRef = selfJoin ? join.innerAlias : join.collection;
		const inner = quoteIdent(innerRef);
		const fromClause = selfJoin
			? `${quoteIdent(join.collection)} AS ${inner}`
			: inner;
		const foreign = qualify(innerRef, join.foreignField);
		const local = qualify(base, join.localField);
		return `(SELECT count(*) FROM ${fromClause} WHERE ${foreign} = ${local})`;
	}

	function renderEmbedSubquery(join: JoinSpec, base: string): string {
		// Self-join : le nom de la table interne masquerait la base → on l'aliase.
		const selfJoin = join.collection === base;
		const innerRef = selfJoin ? join.innerAlias : join.collection;
		const inner = quoteIdent(innerRef);
		const fromClause = selfJoin
			? `${quoteIdent(join.collection)} AS ${inner}`
			: inner;
		const foreign = qualify(innerRef, join.foreignField);
		const local = qualify(base, join.localField);
		return dialect.embedAgg({
			innerRef: inner,
			fromClause,
			correlation: `${foreign} = ${local}`
		});
	}

	function renderLeftJoin(join: JoinSpec, base: string): string {
		// Self-join : on aliase toujours pour éviter l'ambigüité avec la base.
		const selfJoin = join.collection === base;
		const table = quoteIdent(join.collection);
		const alias = quoteIdent(join.as);
		const table_ref = selfJoin || join.as !== join.collection
			? `${table} AS ${alias}`
			: table;
		const local = qualify(base, join.localField);
		const foreign = qualify(join.as, join.foreignField);
		return `LEFT JOIN ${table_ref} ON ${foreign} = ${local}`;
	}

	function renderExpr(expr: PlanExpr, params: ParamList): string {
		switch (expr.kind) {
			case "literal":
				return expr.value === null ? "NULL" : params.add(expr.value, expr.span);
			case "field":
				return renderPath(expr.path);
			case "compare":
				return `${renderExpr(expr.left, params)} ${COMPARE_SQL[expr.op]} ${renderExpr(expr.right, params)}`;
			case "and":
				return `(${renderExpr(expr.left, params)} AND ${renderExpr(expr.right, params)})`;
			case "or":
				return `(${renderExpr(expr.left, params)} OR ${renderExpr(expr.right, params)})`;
			case "not":
				return `(NOT ${renderExpr(expr.operand, params)})`;
			case "isNull":
				return `${renderExpr(expr.operand, params)} IS ${expr.negated ? "NOT NULL" : "NULL"}`;
			case "in": {
				// `x IN ()` est invalide en SQL ; l'ensemble vide est toujours faux.
				if (expr.values.length === 0) {
					return dialect.falseLiteral();
				}
				const target = renderExpr(expr.target, params);
				// `x in (subquery)` — le subquery se rend déjà en
				// `(SELECT ...)`, donc pas de parens supplémentaires. Détecte le
				// cas single-value=subquery.
				if (
					expr.values.length === 1 &&
					expr.values[0]?.kind === "subquery"
				) {
					return `${target} IN ${renderExpr(expr.values[0], params)}`;
				}
				const list = expr.values.map((v) => renderExpr(v, params)).join(", ");
				return `${target} IN (${list})`;
			}
			case "arith":
				// Parens défensives systématiques : le codegen ne dépend pas de la
				// précédence native du moteur, chaque sous-expr est isolée. Les
				// opérandes littéraux décimaux sont annotés via typedParam("numeric")
				// — sinon le moteur infère le type depuis l'autre côté (int) et
				// refuse "0.1".
				return `(${renderArithOperand(expr.left, params)} ${expr.op} ${renderArithOperand(expr.right, params)})`;
			case "call": {
				// Délégation au registre : le renderer du dialecte assemble le SQL
				// à partir des args (déjà rendus via ctx.renderExpr). Le planner a déjà
				// vérifié que la fonction existe pour cet engine — l'assert
				// defense-in-depth couvre un bug de synchro registre ↔ capabilities.
				const entry = SNQL_FUNCTIONS.get(expr.name);
				const renderer = entry?.engines[dialect.engine as "postgres"];
				if (renderer === undefined) {
					throw new SnqlError(
						`Fonction '${expr.name}' : renderer ${dialect.engine} absent du registre`,
						"codegen_missing_function_mapping"
					);
				}
				// propage star/unique flags aux renderers aggregates.
				// propage sortKeys aux renderers aggregateMulti.
				// Les renderers scalar existants ignorent ces flags (backward compat).
				return renderer(expr.args, {
					renderExpr: (arg) => renderExpr(arg as PlanExpr, params),
					addParam: (v) => params.add(v as SqlValue),
					...(expr.star === true ? { star: true } : {}),
					...(expr.unique === true ? { unique: true } : {}),
					...(expr.sortKeys !== undefined && expr.sortKeys.length > 0
						? { sortKeys: expr.sortKeys }
						: {})
				}) as string;
			}
			case "cast": {
				// SQL standard : `CAST(x AS T)` — préféré aux formes propriétaires
				// pour la lisibilité (idiome portable, aligné surface SNQL).
				// Enum-ref (ADR-030 Enum/2b) : target absent des builtins → assume
				// enum, émettre l'ident quoted pour préserver le casing.
				const sqlType = dialect.castType(expr.target);
				const targetSql = sqlType ?? quoteIdent(expr.target);
				return `CAST(${renderExpr(expr.operand, params)} AS ${targetSql})`;
			}
			case "object": {
				// Builder d'objet JSON — clés ET valeurs bindées (anti-injection sur
				// clés user-controlled type `O'Brien`). Les types sont annotés via
				// typedParam : sans annotation, un `$N` unknown est inféré text par
				// défaut et un scalaire 42 deviendrait la string "42" dans le JSON
				// final (silent bug destructeur).
				if (expr.entries.length === 0) return dialect.jsonObject([]);
				const parts: string[] = [];
				for (const entry of expr.entries) {
					parts.push(dialect.typedParam(params.add(entry.key), "text"));
					parts.push(renderJsonValue(entry.value, params));
				}
				return dialect.jsonObject(parts);
			}
			case "array": {
				// Builder d'array JSON — même helper renderJsonValue.
				if (expr.items.length === 0) return dialect.jsonArray([]);
				const parts = expr.items.map((item) => renderJsonValue(item, params));
				return dialect.jsonArray(parts);
			}
			case "case": {
				// CASE WHEN <c1> THEN <v1> WHEN <c2> THEN <v2> ELSE <e> END.
				// Parens autour : `case` peut apparaître comme opérande d'un
				// compare/arith — isolement défensif (miroir arith).
				const whens = expr.branches
					.map(
						(b) =>
							`WHEN ${renderExpr(b.cond, params)} THEN ${renderExpr(b.value, params)}`
					)
					.join(" ");
				const elseSql = renderExpr(expr.elseValue, params);
				return `(CASE ${whens} ELSE ${elseSql} END)`;
			}
			case "windowCall": {
				// `FN() OVER (PARTITION BY... ORDER BY...)`. Le renderer window
				// retourne juste `FN()` ; on append la clause OVER.
				const entry = SNQL_FUNCTIONS.get(expr.name);
				const renderer = entry?.engines[dialect.engine as "postgres"];
				if (renderer === undefined) {
					throw new SnqlError(
						`Window function '${expr.name}' : renderer ${dialect.engine} absent`,
						"codegen_missing_function_mapping"
					);
				}
				const fnSql = renderer(expr.args, {
					renderExpr: (a) => renderExpr(a as PlanExpr, params),
					addParam: (v) => params.add(v as SqlValue)
				}) as string;
				const parts: string[] = [];
				if (expr.partitionKeys.length > 0) {
					parts.push(
						`PARTITION BY ${expr.partitionKeys.map((k) => renderPath(k)).join(", ")}`
					);
				}
				if (expr.sortKeys.length > 0) {
					parts.push(
						`ORDER BY ${expr.sortKeys
							.map(
								(k) => `${renderPath(k.path)} ${k.direction === "desc" ? "DESC" : "ASC"}`
							)
							.join(", ")}`
					);
				}
				return `${fnSql} OVER (${parts.join(" ")})`;
			}
			case "subquery": {
				// `(SELECT...)` inline. Le sous-plan est rendu via renderPlan avec
				// les mêmes params (placeholders partagés, bindés séquentiellement).
				return `(${renderPlan(expr.plan, params)})`;
			}
			case "exists": {
				// `EXISTS (SELECT... )`. Idem — sous-plan inline.
				return `EXISTS (${renderPlan(expr.subplan, params)})`;
			}
			case "upsertNew":
				// `new.<col>` dans `on conflict edit set/where` — la référence de la
				// row proposée est dialecte (PG: EXCLUDED).
				return dialect.upsertNewRef(quoteIdent(expr.column));
		}
	}

	/**
	 * Rend une value pour un object/array literal JSON. Annote les literals
	 * scalaires nus avec leur type SQL canonique — sans quoi le placeholder
	 * non typé est inféré text et un scalaire `42` devient la string `"42"`
	 * dans le JSON final. Les non-literals passent par renderExpr standard.
	 */
	function renderJsonValue(expr: PlanExpr, params: ParamList): string {
		if (expr.kind !== "literal") return renderExpr(expr, params);
		const v = expr.value;
		if (v === null) return "NULL";
		if (isSqlDecimal(v)) {
			return dialect.typedParam(params.add(v, expr.span), "numeric");
		}
		if (typeof v === "boolean") {
			return dialect.typedParam(params.add(v, expr.span), "bool");
		}
		if (typeof v === "bigint") {
			return dialect.typedParam(params.add(v, expr.span), "bigint");
		}
		if (typeof v === "number") {
			return Number.isInteger(v)
				? dialect.typedParam(params.add(v, expr.span), "bigint")
				: dialect.typedParam(params.add(v, expr.span), "float");
		}
		// string : annotation text explicite (pattern anti-injection).
		return dialect.typedParam(params.add(v, expr.span), "text");
	}

	/**
	 * Opérande arithmétique : annote un littéral décimal avec le cast numeric du
	 * dialecte pour que le moteur type le param correctement dans un contexte où
	 * l'autre côté est int. Toutes les autres formes passent par renderExpr —
	 * leur type est inféré via colonne / retour de fonction / cast voisin.
	 */
	function renderArithOperand(expr: PlanExpr, params: ParamList): string {
		if (
			expr.kind === "literal" &&
			expr.value !== null &&
			isSqlDecimal(expr.value)
		) {
			return dialect.typedParam(params.add(expr.value, expr.span), "numeric");
		}
		return renderExpr(expr, params);
	}

	function renderProjection(field: PlanProjectField, params: ParamList): string {
		// Une expression projetée rend son SQL calculé et exige toujours un alias
		// (contrat lower_pick_expr_alias). Un chemin simple garde le comportement
		// historique.
		if (field.expr !== undefined) {
			return `${renderExpr(field.expr, params)} AS ${quoteIdent(field.alias as string)}`;
		}
		const path = renderPath(field.path);
		return field.alias !== undefined
			? `${path} AS ${quoteIdent(field.alias)}`
			: path;
	}

	return {
		dialect,
		newParams: () => new ParamList(dialect),
		quoteIdent,
		renderPlan,
		renderExpr,
		renderProjection,
		renderSortKey,
		renderPath,
		renderJoinPath
	};
}
