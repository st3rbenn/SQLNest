import { describe, expect, it } from "vitest";
import { compile, getMapper, MSSQL_EMULATED_REF_PROPERTY } from "../index";
import { lowerDDL } from "../ir/lower-ddl";
import * as lowerModule from "../ir/lower";
import { lowerMutation, lowerRaw, lowerTransaction } from "../ir/lower";
import { parse } from "../parser/parser";
import { tokenize } from "../lexer/lexer";

function sql(source: string): {
	text: string;
	params: readonly unknown[];
	jsonColumns?: readonly string[];
} {
	const { native } = compile(source, { engine: "mssql" });
	if (native.kind !== "sql") throw new Error("attendu du SQL");
	return {
		text: native.text,
		params: native.params,
		...(native.jsonColumns !== undefined
			? { jsonColumns: native.jsonColumns }
			: {})
	};
}

describe("codegen mssql — clauses de base (dialecte T-SQL)", () => {
	it("requête canonique : brackets, @pN, OFFSET-FETCH", () => {
		const { text, params } = sql(
			`get users where age > 30 and status = "active" pick name, email sort created_at desc limit 10 offset 20`
		);
		expect(text).toBe(
			`SELECT [name], [email] FROM [users] WHERE ([age] > @p1 AND [status] = @p2) ORDER BY [created_at] DESC OFFSET @p4 ROWS FETCH NEXT @p3 ROWS ONLY`
		);
		expect(params).toEqual([30, "active", 10, 20]);
	});

	it("SELECT * sans pick", () => {
		const { text, params } = sql("get users");
		expect(text).toBe(`SELECT * FROM [users]`);
		expect(params).toEqual([]);
	});

	it("limit sans offset → TOP (@pN), pas d'ORDER BY exigé", () => {
		const { text, params } = sql("get users limit 3");
		expect(text).toBe(`SELECT TOP (@p1) * FROM [users]`);
		expect(params).toEqual([3]);
	});

	it("limit + offset SANS sort → ORDER BY (SELECT NULL) forcé", () => {
		const { text, params } = sql("get users limit 5 offset 10");
		expect(text).toBe(
			`SELECT * FROM [users] ORDER BY (SELECT NULL) OFFSET @p2 ROWS FETCH NEXT @p1 ROWS ONLY`
		);
		expect(params).toEqual([5, 10]);
	});

	it("limit + sort sans offset → TOP + ORDER BY", () => {
		const { text } = sql("get users sort name limit 3");
		expect(text).toBe(
			`SELECT TOP (@p1) * FROM [users] ORDER BY [name] ASC`
		);
	});

	it("alias + chemins pointés", () => {
		const { text, params } = sql(
			"get users as u where u.age >= 18 pick u.name as name"
		);
		expect(text).toBe(
			`SELECT [u].[name] AS [name] FROM [users] AS [u] WHERE [u].[age] >= @p1`
		);
		expect(params).toEqual([18]);
	});

	it("in vide → (1 = 0), T-SQL n'a pas de littéral FALSE", () => {
		const { text } = sql("get users where role in []");
		expect(text).toBe(`SELECT * FROM [users] WHERE (1 = 0)`);
	});

	it("= null → IS NULL", () => {
		const { text } = sql("get users where deleted_at = null");
		expect(text).toBe(`SELECT * FROM [users] WHERE [deleted_at] IS NULL`);
	});
});

describe("codegen mssql — joins", () => {
	it("embed one-to-many → FOR JSON PATH + jsonColumns", () => {
		const { text, jsonColumns } = sql(
			"get artists with albums on ArtistId = ArtistId"
		);
		expect(text).toBe(
			`SELECT [artists].*, COALESCE((SELECT [albums].* FROM [albums] WHERE [albums].[ArtistId] = [artists].[ArtistId] FOR JSON PATH, INCLUDE_NULL_VALUES), N'[]') AS [albums] FROM [artists]`
		);
		expect(jsonColumns).toEqual(["albums"]);
	});

	it("self-join embed : table interne aliasée", () => {
		const { text } = sql(
			"get employees with employees as reports on EmployeeId = ReportsTo"
		);
		expect(text).toContain(`FROM [employees] AS [__j0]`);
		expect(text).toContain(
			`[__j0].[ReportsTo] = [employees].[EmployeeId]`
		);
	});
});

describe("codegen mssql — aggregate / group / having", () => {
	it("count(*) → COUNT_BIG(*), group + having", () => {
		const { text, params } = sql(
			`get invoices group by CustomerId having count(*) > 5 pick CustomerId, count(*) as n`
		);
		expect(text).toBe(
			`SELECT [CustomerId], COUNT_BIG(*) AS [n] FROM [invoices] GROUP BY [CustomerId] HAVING COUNT_BIG(*) > @p1`
		);
		expect(params).toEqual([5]);
	});

	it("avg cast float (AVG int T-SQL tronque), sum cast float", () => {
		const { text } = sql(
			"get tracks pick avg(Milliseconds) as a, sum(UnitPrice) as s"
		);
		expect(text).toBe(
			`SELECT AVG(CAST([Milliseconds] AS float)) AS [a], CAST(SUM([UnitPrice]) AS float) AS [s] FROM [tracks]`
		);
	});
});

describe("codegen mssql — fonctions (renderers T-SQL)", () => {
	it("strpos → CHARINDEX args INVERSÉS", () => {
		const { text, params } = sql(
			`get users pick strpos(email, "@") as pos`
		);
		expect(text).toBe(
			`SELECT CHARINDEX(@p1, [email]) AS [pos] FROM [users]`
		);
		expect(params).toEqual(["@"]);
	});

	it("length → hack LEN trailing spaces", () => {
		const { text } = sql("get users pick length(name) as n");
		expect(text).toBe(
			`SELECT (LEN([name] + N'.') - 1) AS [n] FROM [users]`
		);
	});

	it("if → IIF, ceil → CEILING", () => {
		const { text } = sql(
			`get t pick if(x > 1, "big", "small") as size, ceil(y) as c`
		);
		expect(text).toBe(
			`SELECT IIF([x] > @p1, @p2, @p3) AS [size], CEILING([y]) AS [c] FROM [t]`
		);
	});

	it("date_diff hour → durée réelle (pas DATEDIFF boundary-count)", () => {
		const { text } = sql(
			`get sessions pick date_diff("hour", ended_at, started_at) as h`
		);
		expect(text).toBe(
			`SELECT CAST(FLOOR((CAST(DATEDIFF(second, [started_at], [ended_at]) AS bigint) * 1000 + DATEDIFF(millisecond, DATEADD(second, DATEDIFF(second, [started_at], [ended_at]), [started_at]), [ended_at])) / 3600000.0) AS int) AS [h] FROM [sessions]`
		);
	});

	it("date_trunc week → iso_week (indépendant de @@DATEFIRST)", () => {
		const { text } = sql(
			`get events pick date_trunc("week", created_at) as w`
		);
		expect(text).toBe(
			`SELECT DATEADD(week, DATEDIFF(day, '1900-01-01', [created_at]) / 7, '1900-01-01') AS [w] FROM [events]`
		);
	});

	it("round 1-arg → ROUND(n, 0) (T-SQL exige 2 args)", () => {
		const { text } = sql("get t pick round(x) as r");
		expect(text).toBe(`SELECT ROUND([x], 0) AS [r] FROM [t]`);
	});
});

describe("codegen mssql — cast", () => {
	it("targets canoniques → types T-SQL", () => {
		const { text } = sql(
			`get t pick cast(a as int) as i, cast(b as text) as s, cast(c as bool) as f`
		);
		expect(text).toBe(
			`SELECT CAST([a] AS bigint) AS [i], CAST([b] AS nvarchar(max)) AS [s], CAST([c] AS bit) AS [f] FROM [t]`
		);
	});
});

describe("codegen mssql — subqueries", () => {
	it("in (find …) → IN (SELECT …) natif", () => {
		const { text, params } = sql(
			`get albums where ArtistId in (find artists where Name = "AC/DC" pick ArtistId)`
		);
		expect(text).toBe(
			`SELECT * FROM [albums] WHERE [ArtistId] IN (SELECT [ArtistId] FROM [artists] WHERE [Name] = @p1)`
		);
		expect(params).toEqual(["AC/DC"]);
	});
});

describe("codegen mssql — window functions", () => {
	it("row_number() over partition/sort", () => {
		const { text } = sql(
			"get tracks pick Name, row_number() over (partition AlbumId sort Milliseconds desc) as rn"
		);
		expect(text).toBe(
			`SELECT [Name], ROW_NUMBER() OVER (PARTITION BY [AlbumId] ORDER BY [Milliseconds] DESC) AS [rn] FROM [tracks]`
		);
	});
});

describe("codegen mssql — pick unique", () => {
	it("unique simple → SELECT DISTINCT", () => {
		const { text } = sql("get users pick unique country");
		expect(text).toBe(`SELECT DISTINCT [country] FROM [users]`);
	});

	it("unique on (keys) → wrap ROW_NUMBER (pas de DISTINCT ON T-SQL)", () => {
		const { text } = sql(
			"get invoices pick unique on (CustomerId) CustomerId, Total sort CustomerId, Total desc"
		);
		expect(text).toBe(
			`SELECT * FROM (SELECT [CustomerId], [Total], ROW_NUMBER() OVER (PARTITION BY [CustomerId] ORDER BY [CustomerId] ASC, [Total] DESC) AS [__sqlnest_rn] FROM [invoices]) AS [__sqlnest_don] WHERE [__sqlnest_rn] = 1 ORDER BY [CustomerId] ASC, [Total] DESC`
		);
	});
});

describe("codegen mssql — raw", () => {
	it("raw \"SQL\" → SqlQuery passthrough", () => {
		const stmt = parse(tokenize(`raw "SELECT TOP 3 * FROM Artist"`));
		if (stmt.operation !== "raw") throw new Error("raw attendu");
		const native = getMapper("mssql").mapRaw!(lowerRaw(stmt));
		expect(native).toMatchObject({
			engine: "mssql",
			kind: "sql",
			text: "SELECT TOP 3 * FROM Artist",
			params: []
		});
	});
});

// ─── M/4 — mutations ─────────────────────────────────────────

function mutationSql(source: string): {
	text: string;
	params: readonly unknown[];
} {
	const stmt = parse(tokenize(source));
	if (
		stmt.operation !== "insert" &&
		stmt.operation !== "update" &&
		stmt.operation !== "delete"
	) {
		throw new Error(`mutation attendue, reçu '${stmt.operation}'`);
	}
	const native = getMapper("mssql").mapMutation(lowerMutation(stmt));
	if (native.kind !== "sql") throw new Error("attendu du SQL");
	return { text: native.text, params: native.params };
}

describe("codegen mssql — mutations (M/4)", () => {
	it("insert multi-rows → OUTPUT INSERTED.* AVANT VALUES", () => {
		const { text, params } = mutationSql(
			`add [{ name: "a", age: 1 }, { name: "b", age: 2 }] into users`
		);
		expect(text).toBe(
			`INSERT INTO [users] ([name], [age]) OUTPUT INSERTED.* VALUES (@p1, @p2), (@p3, @p4)`
		);
		expect(params).toEqual(["a", 1, "b", 2]);
	});

	it("insert avec NULL inline", () => {
		const { text, params } = mutationSql(
			`add { name: "a", nick: null } into users`
		);
		expect(text).toBe(
			`INSERT INTO [users] ([name], [nick]) OUTPUT INSERTED.* VALUES (@p1, NULL)`
		);
		expect(params).toEqual(["a"]);
	});

	it("update simple → SET puis OUTPUT puis WHERE", () => {
		const { text, params } = mutationSql(
			`edit users where id = 1 set name = "x"`
		);
		expect(text).toBe(
			`UPDATE [users] SET [name] = @p1 OUTPUT INSERTED.* WHERE [id] = @p2`
		);
		expect(params).toEqual(["x", 1]);
	});

	it("delete → OUTPUT DELETED.*", () => {
		const { text, params } = mutationSql(`remove from users where id = 9`);
		expect(text).toBe(
			`DELETE FROM [users] OUTPUT DELETED.* WHERE [id] = @p1`
		);
		expect(params).toEqual([9]);
	});

	it("upsert ignore → MERGE HOLDLOCK sans WHEN MATCHED, `;` terminal", () => {
		const { text, params } = mutationSql(
			`add { id: 1, name: "a" } into users on conflict (id) ignore`
		);
		expect(text).toBe(
			`MERGE INTO [users] WITH (HOLDLOCK) AS [__sqlnest_t] ` +
			`USING (VALUES (@p1, @p2)) AS [__sqlnest_s] ([id], [name]) ` +
			`ON [__sqlnest_t].[id] = [__sqlnest_s].[id] ` +
			`WHEN NOT MATCHED THEN INSERT ([id], [name]) VALUES ([__sqlnest_s].[id], [__sqlnest_s].[name]) ` +
			`OUTPUT INSERTED.*;`
		);
		expect(params).toEqual([1, "a"]);
	});

	it("upsert edit set new.<col> → WHEN MATCHED UPDATE, refs qualifiées", () => {
		const { text, params } = mutationSql(
			`add { id: 1, hits: 1 } into counters on conflict (id) edit set hits = hits + new.hits`
		);
		expect(text).toBe(
			`MERGE INTO [counters] WITH (HOLDLOCK) AS [__sqlnest_t] ` +
			`USING (VALUES (@p1, @p2)) AS [__sqlnest_s] ([id], [hits]) ` +
			`ON [__sqlnest_t].[id] = [__sqlnest_s].[id] ` +
			`WHEN MATCHED THEN UPDATE SET [hits] = ([__sqlnest_t].[hits] + [__sqlnest_s].[hits]) ` +
			`WHEN NOT MATCHED THEN INSERT ([id], [hits]) VALUES ([__sqlnest_s].[id], [__sqlnest_s].[hits]) ` +
			`OUTPUT INSERTED.*;`
		);
		expect(params).toEqual([1, 1]);
	});
});

// ─── M/5 — introspection tier-1 + let/CTE ────────────────────

function introspectSql(source: string): {
	text: string;
	params: readonly unknown[];
} {
	const stmt = parse(tokenize(source));
	if (stmt.operation !== "introspect") throw new Error("introspect attendu");
	const { lowerIntrospect } = requireLower();
	const native = getMapper("mssql").mapIntrospect!(lowerIntrospect(stmt), {
		namespace: "dbo"
	});
	if (native.kind !== "sql") throw new Error("attendu du SQL");
	return { text: native.text, params: native.params };
}

function requireLower(): typeof import("../ir/lower") {
	return lowerModule;
}

describe("codegen mssql — introspection (M/5)", () => {
	it("list tables → INFORMATION_SCHEMA, namespace bindé", () => {
		const { text, params } = introspectSql("list tables");
		expect(text).toBe(
			`SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @p1 AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME NOT LIKE '\\_snql\\_%' ESCAPE '\\' ORDER BY [name] ASC`
		);
		expect(params).toEqual(["dbo"]);
	});

	it("list tables + where/limit → wrap TOP, ordre par défaut conservé", () => {
		const { text } = introspectSql(`list tables where name like "a%" limit 3`);
		expect(text).toBe(
			`SELECT TOP (3) * FROM (SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @p1 AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME NOT LIKE '\\_snql\\_%' ESCAPE '\\') AS [t] WHERE [name] LIKE @p2 ORDER BY [name] ASC`
		);
	});

	it("describe table → colonnes + PK + FK, tri ORDINAL_POSITION", () => {
		const { text, params } = introspectSql("describe track");
		expect(text).toContain("FROM INFORMATION_SCHEMA.COLUMNS c");
		expect(text).toContain("sys.foreign_key_columns");
		expect(text).toContain("ORDER BY c.ORDINAL_POSITION ASC");
		expect(params).toEqual(["dbo", "track"]);
	});

	it("list enums → IF OBJECT_ID garde, branche vide au même shape", () => {
		const { text, params } = introspectSql("list enums");
		expect(text).toBe(
			`IF OBJECT_ID(@p1, N'U') IS NOT NULL SELECT [name], CASE WHEN [members] = '[]' THEN 0 ELSE (LEN([members]) - LEN(REPLACE([members], ',', ''))) + 1 END AS members_count FROM [dbo].[_snql_enums] ORDER BY [name] ASC ELSE SELECT TOP 0 CAST(NULL AS nvarchar(4000)) AS [name], CAST(NULL AS int) AS members_count`
		);
		expect(params).toEqual(["dbo._snql_enums"]);
	});

	it("describe enum → OPENJSON positions 1..N", () => {
		const { text, params } = introspectSql("describe enum statut");
		expect(text).toContain("CROSS APPLY j.x.nodes('/m') AS m(n)");
		expect(text).toContain("count(../*[. << $i]) + 1");
		expect(params).toEqual(["dbo._snql_enums", "statut"]);
	});
});

describe("codegen mssql — let / CTE (M/5)", () => {
	it("let simple → WITH natif", () => {
		const stmt = parse(
			tokenize("let heavy = find track where milliseconds > 300000; find heavy pick name limit 2")
		);
		if (stmt.operation !== "let") throw new Error("let attendu");
		const { lowerLet } = requireLower();
		const native = getMapper("mssql").mapLet!(lowerLet(stmt));
		if (native.kind !== "sql") throw new Error();
		expect(native.text).toBe(
			`WITH [heavy] AS (SELECT * FROM [track] WHERE [milliseconds] > @p1) SELECT TOP (@p2) [name] FROM [heavy]`
		);
		expect(native.params).toEqual([300000, 2]);
	});

	it("let rec → WITH nu (pas de mot-clé RECURSIVE en T-SQL)", () => {
		const stmt = parse(
			tokenize(
				"let rec chain = find employee where reports_to = null pick employee_id, reports_to union all find employee as e with one chain as c on e.reports_to = c.employee_id pick e.employee_id, e.reports_to; find chain limit 50"
			)
		);
		if (stmt.operation !== "let") throw new Error("let attendu");
		const { lowerLet } = requireLower();
		const native = getMapper("mssql").mapLet!(lowerLet(stmt));
		if (native.kind !== "sql") throw new Error();
		expect(native.text).toMatch(/^WITH \[chain\] AS \(\(/);
		expect(native.text).toContain("UNION ALL");
		expect(native.text).not.toContain("RECURSIVE");
	});
});

// ─── M/6 — DDL Tier-2 (plans construits, miroir du harness pg-ddl) ───

function mapDdl(plan: import("../ir/plan").DDLPlan) {
	return getMapper("mssql").mapDDL!(plan, { namespace: "dbo" });
}

function ddlText(plan: import("../ir/plan").DDLPlan): {
	text: string;
	params: readonly unknown[];
} {
	const native = mapDdl(plan);
	if (native.kind !== "sql") throw new Error(`attendu sql, reçu ${native.kind}`);
	return { text: native.text, params: native.params };
}

describe("codegen mssql — DDL (M/6)", () => {
	it("create table : types DDL, PK, string clé → nvarchar(450)", () => {
		const { text, params } = ddlText({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "id", type: "string", nullable: false, unique: false },
				{ name: "age", type: "int", nullable: false, unique: false },
				{ name: "bio", type: "string", nullable: true, unique: false },
				{
					name: "active",
					type: "bool",
					nullable: false,
					unique: false,
					defaultValue: true
				}
			],
			primaryKey: ["id"]
		});
		expect(text).toBe(
			`CREATE TABLE [dbo].[users] ([id] nvarchar(450) NOT NULL, [age] int NOT NULL, [bio] nvarchar(max), [active] bit NOT NULL DEFAULT 1, PRIMARY KEY ([id]))`
		);
		expect(params).toEqual([]);
	});

	it("create table if not exists → SqlTransaction sp_getapplock + guard", () => {
		const native = mapDdl({
			op: "ddl",
			kind: "create-table",
			target: "t",
			ifNotExists: true,
			fields: [{ name: "id", type: "int", nullable: false, unique: false }],
			primaryKey: ["id"]
		});
		expect(native.kind).toBe("transaction");
		if (native.kind !== "transaction") throw new Error();
		const [lock, create] = native.steps;
		if (lock?.kind !== "statement" || create?.kind !== "statement") {
			throw new Error();
		}
		expect(lock.query.text).toContain("sp_getapplock");
		expect(lock.query.params).toEqual(["sqlnest_ddl:t"]);
		expect(create.query.text).toBe(
			`IF OBJECT_ID(N'[dbo].[t]', N'U') IS NULL CREATE TABLE [dbo].[t] ([id] int NOT NULL, PRIMARY KEY ([id]))`
		);
	});

	it("create table avec ref → FK inline au type de la colonne référencée, relu au catalogue ; restrict → NO ACTION", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "create-table",
			target: "orders",
			ifNotExists: false,
			fields: [
				{ name: "id", type: "int", nullable: false, unique: false },
				{
					name: "user_id",
					type: "int",
					nullable: false,
					unique: false,
					ref: {
						name: "fk_orders_user_id",
						fromColumn: "user_id",
						targetCollection: "users",
						targetColumn: "id",
						onDelete: "restrict",
						onUpdate: "restrict"
					}
				}
			],
			primaryKey: ["id"]
		});
		const lines = text.split("\n");
		expect(lines[0]).toBe("SET NOCOUNT ON;");
		expect(lines[1]).toMatch(
			/^DECLARE @type_user_id nvarchar\(300\) = ISNULL\(\(SELECT CASE$/
		);
		// Type complet (longueur, précision, collation) de users.id, sinon le type SNQL.
		expect(text).toContain(
			"ELSE ty.name END + ISNULL(N' COLLATE ' + c.collation_name, N'') FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id WHERE c.object_id = OBJECT_ID(N'[dbo].[users]') AND c.name = N'id'), N'int');"
		);
		expect(lines.at(-1)).toBe(
			"EXEC (N'CREATE TABLE [dbo].[orders] ([id] int NOT NULL, [user_id] ' + @type_user_id + N' NOT NULL CONSTRAINT [fk_orders_user_id] REFERENCES [dbo].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION, PRIMARY KEY ([id]))');"
		);
	});

	it("create table : FK vers la table créée → type de la colonne visée, sans lecture du catalogue", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "create-table",
			target: "category",
			ifNotExists: false,
			fields: [
				{ name: "code", type: "string", nullable: false, unique: false },
				{
					name: "parent_code",
					type: "string",
					nullable: true,
					unique: false,
					ref: {
						name: "fk_category_parent_code_category",
						fromColumn: "parent_code",
						targetCollection: "category",
						targetColumn: "code",
						onDelete: "restrict",
						onUpdate: "restrict"
					}
				}
			],
			primaryKey: ["code"]
		});
		expect(text).toBe(
			"CREATE TABLE [dbo].[category] ([code] nvarchar(450) NOT NULL, [parent_code] nvarchar(450) CONSTRAINT [fk_category_parent_code_category] REFERENCES [dbo].[category] ([code]) ON DELETE NO ACTION ON UPDATE NO ACTION, PRIMARY KEY ([code]))"
		);
	});

	it("create table if not exists avec ref → le type est relu dans l'étape gardée", () => {
		const native = mapDdl({
			op: "ddl",
			kind: "create-table",
			target: "c",
			ifNotExists: true,
			fields: [
				{
					name: "b",
					type: "string",
					nullable: true,
					unique: false,
					ref: {
						name: "fk_c_b_p",
						fromColumn: "b",
						targetCollection: "p",
						targetColumn: "code",
						onDelete: "restrict",
						onUpdate: "restrict"
					}
				}
			]
		});
		if (native.kind !== "transaction") throw new Error(native.kind);
		const create = native.steps[1];
		if (create?.kind !== "statement") throw new Error();
		const lines = create.query.text.split("\n");
		expect(lines[0]).toBe("SET NOCOUNT ON;");
		expect(create.query.text).toContain(
			"WHERE c.object_id = OBJECT_ID(N'[dbo].[p]') AND c.name = N'code'), N'nvarchar(max)');"
		);
		expect(lines.at(-1)).toBe(
			"IF OBJECT_ID(N'[dbo].[c]', N'U') IS NULL EXEC (N'CREATE TABLE [dbo].[c] ([b] ' + @type_b + N' CONSTRAINT [fk_c_b_p] REFERENCES [dbo].[p] ([code]) ON DELETE NO ACTION ON UPDATE NO ACTION)');"
		);
	});

	it("create table field enum → nvarchar(450) + CHECK IN members", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "create-table",
			target: "posts",
			ifNotExists: false,
			fields: [
				{ name: "id", type: "int", nullable: false, unique: false },
				{
					name: "statut",
					type: "enum",
					nullable: false,
					unique: false,
					enumTypeName: "statut",
					enumMembers: ["brouillon", "publie"]
				}
			],
			primaryKey: ["id"]
		});
		expect(text).toContain(
			`[statut] nvarchar(450) NOT NULL CONSTRAINT [ck_posts_statut_enum] CHECK ([statut] IN (N'brouillon', N'publie'))`
		);
	});

	it("add column nullable + default → WITH VALUES (backfill D10)", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: false,
			column: {
				name: "note",
				type: "string",
				nullable: true,
				unique: false,
				defaultValue: "aucune"
			}
		});
		expect(text).toBe(
			`ALTER TABLE [dbo].[users] ADD [note] nvarchar(max) DEFAULT 'aucune' WITH VALUES`
		);
	});

	it("add column … ref → type relu au catalogue ; WITH VALUES suit le DEFAULT, avant la FK", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "add-column",
			target: "c",
			ifNotExists: true,
			column: {
				name: "b",
				type: "string",
				nullable: true,
				unique: false,
				defaultValue: "zz",
				ref: {
					name: "fk_c_b_p",
					fromColumn: "b",
					targetCollection: "p",
					targetColumn: "code",
					onDelete: "restrict",
					onUpdate: "restrict"
				}
			}
		});
		expect(text).toContain(
			"WHERE c.object_id = OBJECT_ID(N'[dbo].[p]') AND c.name = N'code'), N'nvarchar(max)');"
		);
		expect(text.split("\n").at(-1)).toBe(
			"IF COL_LENGTH(N'[dbo].[c]', N'b') IS NULL EXEC (N'ALTER TABLE [dbo].[c] ADD [b] ' + @type_b + N' DEFAULT ''zz'' WITH VALUES CONSTRAINT [fk_c_b_p] REFERENCES [dbo].[p] ([code]) ON DELETE NO ACTION ON UPDATE NO ACTION');"
		);
	});

	it("add column if not exists → guard COL_LENGTH", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: true,
			column: { name: "age", type: "int", nullable: false, unique: false }
		});
		expect(text).toBe(
			`IF COL_LENGTH(N'[dbo].[users]', N'age') IS NULL ALTER TABLE [dbo].[users] ADD [age] int NOT NULL`
		);
	});

	it("add unique index + if not exists : index existant → sortie avant toute modification", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "add-unique-index",
			target: "users",
			fields: ["email"],
			name: "unique_users_email",
			ifNotExists: true
		});
		expect(text).toContain(
			"DECLARE @obj int = OBJECT_ID(N'[dbo].[users]');\nIF EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'unique_users_email' AND object_id = @obj) RETURN;\nBEGIN TRAN;"
		);
		expect(text).toContain(
			"CREATE UNIQUE INDEX [unique_users_email] ON [dbo].[users] ([email]);\nCOMMIT;"
		);
	});

	it("add index sur une colonne (max) → rétrécie à 900 octets dans la transaction, puis CREATE INDEX", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "add-index",
			target: "e1e_kid",
			fields: ["tier"],
			name: "idx_e1e_kid_tier",
			ifNotExists: false
		});
		expect(
			text.startsWith(
				"SET NOCOUNT ON;\nSET XACT_ABORT ON;\nDECLARE @obj int = OBJECT_ID(N'[dbo].[e1e_kid]');\nBEGIN TRAN;"
			)
		).toBe(true);
		// Seules les colonnes (max) ou text / ntext / image de l'index changent ;
		// nullabilité et collation suivent.
		expect(text).toContain(
			"(ty.name IN (N'ntext', N'text', N'image') OR (c.max_length = -1 AND ty.name IN (N'nvarchar', N'varchar', N'varbinary'))) AND c.name IN (N'tier')"
		);
		expect(text).toContain(
			"CASE WHEN ty.name IN (N'nvarchar', N'ntext') THEN N' nvarchar(450)' WHEN ty.name IN (N'varchar', N'text') THEN N' varchar(900)' ELSE N' varbinary(900)' END + ISNULL(N' COLLATE ' + c.collation_name, N'') + CASE WHEN c.is_nullable = 1 THEN N' NULL' ELSE N' NOT NULL' END"
		);
		// Valeurs trop longues comptées en octets (espaces finaux compris) et refusées.
		expect(text).toContain(
			"SELECT @long = COUNT(*) FROM [dbo].[e1e_kid] WHERE DATALENGTH([tier]) > 900;"
		);
		// Limite en caractères pour nvarchar / ntext ; commande `find` pour nvarchar
		// seulement, `length` refusant ntext.
		expect(text).toContain(
			"CASE WHEN @type IN (N'nvarchar', N'ntext') THEN N'450 caractères' ELSE N'900 octets' END"
		);
		expect(text).toContain(
			"CASE WHEN @type = N'nvarchar' THEN N' : find e1e_kid where length(tier) > 450' ELSE N'' END"
		);
		const steps = [
			"THROW 50000, @msg, 1;",
			"EXEC (@dropFk); EXEC (@dropIdx); EXEC (@dropChk); EXEC (@dropDf); EXEC (@dropSt);",
			"EXEC (@alter);",
			"EXEC (@addSt); EXEC (@addDf); EXEC (@addChk); EXEC (@addIdx); EXEC (@addFk);",
			"CREATE INDEX [idx_e1e_kid_tier] ON [dbo].[e1e_kid] ([tier]);",
			"COMMIT;"
		].map((step) => text.indexOf(step));
		expect(
			steps.every((at, i) => at >= 0 && (i === 0 || at > (steps[i - 1] ?? 0)))
		).toBe(true);
	});

	it("add index composé → un contrôle de longueur par colonne", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "add-unique-index",
			target: "t",
			fields: ["tier", "code"],
			name: "unique_t_tier_code",
			ifNotExists: false
		});
		expect(text).toContain("AND c.name IN (N'tier', N'code');");
		expect(text).toContain("WHERE DATALENGTH([tier]) > 900;");
		expect(text).toContain("WHERE DATALENGTH([code]) > 900;");
		expect(text).toContain(
			"CREATE UNIQUE INDEX [unique_t_tier_code] ON [dbo].[t] ([tier], [code]);"
		);
	});

	it("drop index → ON table obligatoire T-SQL", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "drop-index",
			target: "users",
			name: "idx_users_email",
			ifExists: false
		});
		expect(text).toBe(`DROP INDEX [idx_users_email] ON [dbo].[users]`);
	});

	it("drop table / drop column / drop ref", () => {
		expect(
			ddlText({
				op: "ddl",
				kind: "drop-table",
				target: "tmp",
				ifExists: true
			}).text
		).toBe(
			`IF OBJECT_ID(N'[dbo].[tmp]', N'U') IS NOT NULL DROP TABLE [dbo].[tmp]`
		);
		const dropColumn = ddlText({
			op: "ddl",
			kind: "drop-column",
			target: "users",
			column: "note",
			ifExists: false
		}).text;
		// Dépendants (FK portées, index, CHECK, DEFAULT, statistiques) retirés
		// avant la colonne, relus au catalogue à l'exécution.
		expect(dropColumn).toContain(
			"IF @col IS NULL THROW 50000, N'colonne ''users.note'' inconnue', 1;"
		);
		expect(dropColumn).toContain("FROM sys.default_constraints dc");
		expect(dropColumn).toContain("FROM sys.check_constraints cc");
		expect(dropColumn).toContain(
			"EXEC (N'ALTER TABLE [dbo].[users] DROP COLUMN [note]');"
		);
		expect(
			ddlText({
				op: "ddl",
				kind: "drop-ref",
				target: "orders",
				name: "fk_orders_user_id",
				ifExists: false
			}).text
		).toBe(`ALTER TABLE [dbo].[orders] DROP CONSTRAINT [fk_orders_user_id]`);
	});

	it("alter column → transaction : dépendants retirés, ALTER COLUMN, dépendants recréés", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "alter-column",
			target: "agency",
			column: "zip",
			action: { kind: "set-not-null" }
		});
		expect(text.startsWith("SET NOCOUNT ON;\nSET XACT_ABORT ON;\nBEGIN TRAN;")).toBe(true);
		expect(text).toContain("N' NOT NULL'");
		expect(text).toContain(
			"EXEC (@dropFk); EXEC (@dropIdx); EXEC (@dropChk); EXEC (@dropDf); EXEC (@dropSt);"
		);
		expect(text).toContain("EXEC (@alter);");
		expect(text).toContain(
			"EXEC (@addSt); EXEC (@addDf); EXEC (@addChk); EXEC (@addIdx); EXEC (@addFk);"
		);
		// Statistiques créées à la main : filtre et NORECOMPUTE reposés.
		expect(text).toContain("FROM sys.stats s\nWHERE s.user_created = 1 AND");
		expect(text).toContain(
			"ISNULL(N' WHERE ' + s.filter_definition, N'') + CASE WHEN s.no_recompute = 1 THEN N' WITH NORECOMPUTE' ELSE N'' END"
		);
		expect(text.endsWith("COMMIT;")).toBe(true);
	});

	it("alter column set type enum → CHECK d'enum reposé", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "alter-column",
			target: "agency",
			column: "tier",
			action: { kind: "set-type", type: "enum", enumTypeName: "TIER", enumMembers: ["a", "b"] }
		});
		// Les colonnes liées par FK suivent, de proche en proche, toutes au même
		// type : nvarchar(450) dès que l'une est indexée.
		expect(text).toContain(
			"INSERT @targets (obj, col) VALUES (@obj, @col);\nWHILE @@ROWCOUNT > 0\nINSERT @targets (obj, col) SELECT e.obj, e.col FROM ("
		);
		expect(text).toContain(
			"CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN @targets k ON k.obj = ic.object_id AND k.col = ic.column_id) THEN N'nvarchar(450)' ELSE N'nvarchar(450)' END"
		);
		expect(text).toContain("CHECK ([tier] IN (N''a'', N''b''))");
	});

	it("alter column set type : colonnes liées par FK de proche en proche, texte au même type", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "alter-column",
			target: "p",
			column: "code",
			action: { kind: "set-type", type: "string" }
		});
		// Colonnes qui référencent, colonne référencée, et leurs autres FK.
		expect(text).toContain(
			"SELECT fkc.parent_object_id, fkc.parent_column_id FROM sys.foreign_key_columns fkc JOIN @targets tg ON tg.obj = fkc.referenced_object_id AND tg.col = fkc.referenced_column_id"
		);
		expect(text).toContain(
			"UNION SELECT fkc.referenced_object_id, fkc.referenced_column_id FROM sys.foreign_key_columns fkc JOIN @targets tg ON tg.obj = fkc.parent_object_id AND tg.col = fkc.parent_column_id"
		);
		expect(text).toContain(
			"THEN N'nvarchar(450)' ELSE N'nvarchar(max)' END + CASE WHEN c.is_nullable = 1 THEN N' NULL' ELSE N' NOT NULL' END\nFROM @targets tg JOIN sys.columns c"
		);
		// Nullabilité : la colonne seule, sans ses partenaires.
		const nullable = ddlText({
			op: "ddl",
			kind: "alter-column",
			target: "p",
			column: "code",
			action: { kind: "set-nullable" }
		}).text;
		expect(nullable).not.toContain("WHILE @@ROWCOUNT > 0");
		expect(nullable).toContain(
			"ISNULL(N' COLLATE ' + c.collation_name, N'') + N' NULL'"
		);
	});

	it("set default → défaut existant retiré, df_<t>_<c> posé ; fonctions natives", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "alter-column",
			target: "agency",
			column: "created",
			action: { kind: "set-default", value: { kind: "fn", fn: "now" } }
		});
		expect(text).toContain("FROM sys.default_constraints dc");
		expect(text).toContain(
			"ALTER TABLE [dbo].[agency] ADD CONSTRAINT [df_agency_created] DEFAULT SYSDATETIMEOFFSET() FOR [created];"
		);
		const drop = ddlText({
			op: "ddl",
			kind: "alter-column",
			target: "agency",
			column: "created",
			action: { kind: "drop-default" }
		}).text;
		expect(drop).toContain("EXEC (@drop);");
		expect(drop).not.toContain("ADD CONSTRAINT");
	});

	it("rename column → sp_rename, nouveau nom sans crochets, une erreur annule tout", () => {
		expect(
			ddlText({
				op: "ddl",
				kind: "rename-column",
				target: "agency",
				column: "phone",
				newName: "mobile"
			}).text.split("\n")
		).toEqual([
			"SET NOCOUNT ON;",
			"SET XACT_ABORT ON;",
			"BEGIN TRY",
			"BEGIN TRAN;",
			"EXEC sp_rename N'[dbo].[agency].[phone]', N'mobile', N'COLUMN';",
			"COMMIT;",
			"END TRY",
			"BEGIN CATCH",
			"IF @@TRANCOUNT > 0 ROLLBACK;",
			"THROW;",
			"END CATCH"
		]);
	});

	it("rename column d'enum : CHECK retiré, colonne renommée, CHECK reposé sous le nouveau nom", () => {
		const lines = ddlText({
			op: "ddl",
			kind: "rename-column",
			target: "agency",
			column: "tier",
			newName: "plan",
			enumMembers: ["free", "pro"]
		}).text.split("\n");
		expect(lines.slice(3, 7)).toEqual([
			"BEGIN TRAN;",
			"ALTER TABLE [dbo].[agency] DROP CONSTRAINT IF EXISTS [ck_agency_tier_enum];",
			"EXEC sp_rename N'[dbo].[agency].[tier]', N'plan', N'COLUMN';",
			"EXEC sp_executesql N'ALTER TABLE [dbo].[agency] WITH CHECK ADD CONSTRAINT [ck_agency_plan_enum] CHECK ([plan] IN (N''free'', N''pro''))';"
		]);
	});

	it("add enum member : métadonnée, puis CHECK des colonnes de l'enum réécrits", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "add-enum-member",
			name: "tier",
			member: "gold",
			ifNotExists: false,
			usage: {
				members: ["free", "pro"],
				columns: [{ table: "agency", column: "tier" }]
			}
		});
		const lines = text.split("\n");
		expect(lines[0]).toBe("SET XACT_ABORT ON;");
		expect(lines[2]).toMatch(
			/^UPDATE \[dbo\]\.\[_snql_enums\] SET \[members\]/
		);
		expect(lines[3]).toBe(
			"ALTER TABLE [dbo].[agency] DROP CONSTRAINT IF EXISTS [ck_agency_tier_enum]; ALTER TABLE [dbo].[agency] WITH CHECK ADD CONSTRAINT [ck_agency_tier_enum] CHECK ([tier] IN (N'free', N'pro', N'gold'));"
		);
		expect(lines.at(-1)).toBe("COMMIT;");
	});

	it("add ref → colonne passée au type de la colonne référencée, puis WITH CHECK ADD CONSTRAINT (orphelins vérifiés)", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "add-ref",
			target: "orders",
			ref: {
				name: "fk_orders_user_code",
				fromColumn: "user_code",
				targetCollection: "users",
				targetColumn: "code",
				onDelete: "restrict",
				onUpdate: "cascade"
			}
		});
		expect(
			text.startsWith(
				"SET NOCOUNT ON;\nSET XACT_ABORT ON;\nBEGIN TRAN;\nDECLARE @obj int = OBJECT_ID(N'[dbo].[orders]');\nDECLARE @col int = COLUMNPROPERTY(@obj, N'user_code', 'ColumnId');\nDECLARE @refObj int = OBJECT_ID(N'[dbo].[users]');\nDECLARE @refCol int = COLUMNPROPERTY(@refObj, N'code', 'ColumnId');"
			)
		).toBe(true);
		// Convertie seulement si ce que SQL Server compare diffère.
		expect(text).toContain(
			"(c.system_type_id <> r.system_type_id OR c.max_length <> r.max_length OR c.precision <> r.precision OR c.scale <> r.scale OR ISNULL(c.collation_name, N'') <> ISNULL(r.collation_name, N''));\nWHILE @@ROWCOUNT > 0"
		);
		expect(text).toContain(
			"QUOTENAME(c.name) + N' ' + @type + CASE WHEN c.is_nullable = 1 THEN N' NULL' ELSE N' NOT NULL' END"
		);
		// Valeurs trop longues pour le nouveau type, en octets, refusées avant.
		expect(text).toContain(
			"N' WHERE DATALENGTH(CONVERT(' + @wide + N', ' + QUOTENAME(c.name) + N')) > @max;'"
		);
		expect(text).toContain(
			"N''', la longueur de users.code — à raccourcir avant la foreign key', CASE WHEN @unicode = 1 AND @findable = 1 THEN CONCAT(N' : find ', @longTable, N' where length(', @longCol, N') > ', @max / 2) ELSE N'' END);"
		);
		const steps = [
			"THROW 50000, @msg, 1;",
			"EXEC (@dropFk); EXEC (@dropIdx); EXEC (@dropChk); EXEC (@dropDf); EXEC (@dropSt);",
			"EXEC (@alter);",
			"EXEC (@addSt); EXEC (@addDf); EXEC (@addChk); EXEC (@addIdx); EXEC (@addFk);",
			"ALTER TABLE [dbo].[orders] WITH CHECK ADD CONSTRAINT [fk_orders_user_code] FOREIGN KEY ([user_code]) REFERENCES [dbo].[users] ([code]) ON DELETE NO ACTION ON UPDATE CASCADE;",
			"COMMIT;"
		].map((step) => text.indexOf(step));
		expect(
			steps.every((at, i) => at >= 0 && (i === 0 || at > (steps[i - 1] ?? 0)))
		).toBe(true);
	});

	it("create enum → bootstrap _snql_enums + INSERT paramétré", () => {
		const { text, params } = ddlText({
			op: "ddl",
			kind: "create-enum",
			name: "statut",
			members: ["brouillon", "publie"],
			ifNotExists: false
		});
		expect(text).toBe(
			`IF OBJECT_ID(N'[dbo].[_snql_enums]', N'U') IS NULL CREATE TABLE [dbo].[_snql_enums] ([name] nvarchar(128) NOT NULL, [members] nvarchar(max) NOT NULL, CONSTRAINT [_snql_enums_pkey] PRIMARY KEY ([name])); INSERT INTO [dbo].[_snql_enums] ([name], [members]) VALUES (@p1, @p2)`
		);
		expect(params).toEqual(["statut", '["brouillon","publie"]']);
	});

	it("create enum if not exists → INSERT guardé NOT EXISTS", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "create-enum",
			name: "statut",
			members: ["a"],
			ifNotExists: true
		});
		expect(text).toContain(
			`IF NOT EXISTS (SELECT 1 FROM [dbo].[_snql_enums] WHERE [name] = @p1) INSERT INTO`
		);
	});

	it("add enum member → JSON_MODIFY append + dedup OPENJSON", () => {
		const { text, params } = ddlText({
			op: "ddl",
			kind: "add-enum-member",
			name: "statut",
			member: "archive",
			ifNotExists: false
		});
		expect(text).toBe(
			`UPDATE [dbo].[_snql_enums] SET [members] = CASE WHEN [members] = '[]' THEN '[' + @p2 + ']' ELSE STUFF([members], LEN([members]), 1, ',' + @p2 + ']') END WHERE [name] = @p1 AND [members] NOT LIKE @p3 ESCAPE '\\'`
		);
		expect(params).toEqual(["statut", '"archive"', '%"archive"%']);
	});

	it("drop enum → DELETE metadata guardé", () => {
		const { text, params } = ddlText({
			op: "ddl",
			kind: "drop-enum",
			name: "statut",
			ifExists: true,
			cascade: false
		});
		expect(text).toBe(
			`IF OBJECT_ID(N'[dbo].[_snql_enums]', N'U') IS NOT NULL DELETE FROM [dbo].[_snql_enums] WHERE [name] = @p1`
		);
		expect(params).toEqual(["statut"]);
	});
});

describe("codegen mssql — transaction (M/4)", () => {
	it("steps pré-rendus + savepoints, engine mssql", () => {
		const stmt = parse(
			tokenize(
				`transaction { add { id: 7 } into t; savepoint sp1 { remove from t where id = 7 } }`
			)
		);
		if (stmt.operation !== "transaction") throw new Error();
		const native = getMapper("mssql").mapTransaction!(
			lowerTransaction(stmt)
		);
		expect(native.kind).toBe("transaction");
		if (native.kind !== "transaction") throw new Error();
		expect(native.engine).toBe("mssql");
		expect(native.steps.map((s) => s.kind)).toEqual([
			"statement",
			"savepoint-begin",
			"statement",
			"savepoint-release"
		]);
		const first = native.steps[0];
		if (first?.kind !== "statement") throw new Error();
		expect(first.query.text).toBe(
			`INSERT INTO [t] ([id]) OUTPUT INSERTED.* VALUES (@p1)`
		);
	});
});

describe("codegen mssql — profil ORM (ADR-036 E/1e)", () => {
	it("clé primaire, unique et défaut nommés quand le plan porte leur nom", () => {
		expect(
			ddlText({
				op: "ddl",
				kind: "create-table",
				target: "agency",
				ifNotExists: false,
				primaryKey: ["id"],
				primaryKeyName: "agency_pkey",
				fields: [
					{ name: "id", type: "int", nullable: false, unique: false },
					{
						name: "code",
						type: "string",
						nullable: false,
						unique: true,
						uniqueName: "agency_code_key"
					},
					{
						name: "tier",
						type: "string",
						nullable: false,
						unique: false,
						defaultValue: "free",
						defaultName: "agency_tier_df"
					}
				]
			}).text
		).toBe(
			"CREATE TABLE [dbo].[agency] ([id] int NOT NULL, [code] nvarchar(450) NOT NULL CONSTRAINT [agency_code_key] UNIQUE, [tier] nvarchar(max) NOT NULL CONSTRAINT [agency_tier_df] DEFAULT 'free', CONSTRAINT [agency_pkey] PRIMARY KEY ([id]))"
		);
	});

	it("set default : contrainte posée sous le nom du profil", () => {
		expect(
			ddlText({
				op: "ddl",
				kind: "alter-column",
				target: "agency",
				column: "tier",
				action: { kind: "set-default", value: "pro", name: "agency_tier_df" }
			}).text
		).toContain("ADD CONSTRAINT [agency_tier_df] DEFAULT 'pro' FOR [tier];");
	});

	it("défaut écrit comme un ORM le relit : N'…' hors ASCII seulement, bigint sans CAST", () => {
		const setDefault = (value: string | bigint): string =>
			ddlText({
				op: "ddl",
				kind: "alter-column",
				target: "agency",
				column: "tier",
				action: { kind: "set-default", value, name: "agency_tier_df" }
			}).text;
		expect(setDefault("l'été")).toContain("DEFAULT N'l''été' FOR [tier];");
		expect(setDefault(9007199254740993n)).toContain(
			"DEFAULT 9007199254740993 FOR [tier];"
		);
	});

	it("rename column : index, FK et défaut conventionnels renommés dans la même transaction", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "rename-column",
			target: "agency",
			column: "code",
			newName: "slug",
			renames: [
				{ kind: "index", from: "agency_code_key", to: "agency_slug_key" },
				{
					kind: "foreign-key",
					from: "agency_code_fkey",
					to: "agency_slug_fkey"
				},
				{ kind: "default", from: "agency_code_df", to: "agency_slug_df" }
			]
		});
		expect(text.split("\n")).toEqual([
			"SET NOCOUNT ON;",
			"SET XACT_ABORT ON;",
			"BEGIN TRY",
			"BEGIN TRAN;",
			"EXEC sp_rename N'[dbo].[agency].[code]', N'slug', N'COLUMN';",
			"EXEC sp_rename N'[dbo].[agency].[agency_code_key]', N'agency_slug_key', N'INDEX';",
			"EXEC sp_rename N'[dbo].[agency_code_fkey]', N'agency_slug_fkey', N'OBJECT';",
			"IF EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'agency_code_df' AND parent_object_id = OBJECT_ID(N'[dbo].[agency]')) EXEC sp_rename N'[dbo].[agency_code_df]', N'agency_slug_df', N'OBJECT';",
			"COMMIT;",
			"END TRY",
			"BEGIN CATCH",
			"IF @@TRANCOUNT > 0 ROLLBACK;",
			"THROW;",
			"END CATCH"
		]);
	});
});

describe("codegen mssql — schéma de la connexion (E/2c)", () => {
	it("le DDL vise le schéma `?schema=`, pas dbo", () => {
		const ddl = getMapper("mssql").mapDDL;
		if (ddl === undefined) throw new Error("mapDDL absent");
		const text = (plan: import("../ir/plan").DDLPlan): string => {
			const native = ddl(plan, { namespace: "sales" });
			if (native.kind !== "sql") throw new Error(native.kind);
			return native.text;
		};
		expect(
			text({
				op: "ddl",
				kind: "create-table",
				target: "orders",
				ifNotExists: false,
				fields: [
					{
						name: "user_id",
						type: "int",
						nullable: false,
						unique: false,
						ref: {
							name: "fk_orders_user_id",
							fromColumn: "user_id",
							targetCollection: "users",
							targetColumn: "id",
							onDelete: "restrict",
							onUpdate: "restrict"
						}
					}
				]
			})
		).toContain(
			"WHERE c.object_id = OBJECT_ID(N'[sales].[users]') AND c.name = N'id'), N'int');\nEXEC (N'CREATE TABLE [sales].[orders] ([user_id] ' + @type_user_id + N' NOT NULL CONSTRAINT [fk_orders_user_id] REFERENCES [sales].[users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION)');"
		);
		expect(
			text({ op: "ddl", kind: "drop-table", target: "orders", ifExists: false })
		).toBe("DROP TABLE [sales].[orders]");
		expect(
			text({
				op: "ddl",
				kind: "drop-index",
				target: "orders",
				name: "idx",
				ifExists: false
			})
		).toBe("DROP INDEX [idx] ON [sales].[orders]");
	});
});

describe("codegen mssql — FK compensées (ADR-031 D9)", () => {
	const field = (name: string): import("../schema/model").Field => ({
		name,
		type: "int",
		nullable: true,
		source: "declared"
	});
	const schema: import("../schema/model").SchemaModel = {
		engine: "mssql",
		collections: [
			{
				name: "agency",
				source: "declared",
				primaryKey: ["id"],
				fields: [field("id"), field("code")],
				indexes: [{ name: "agency_code_key", columns: ["code"], unique: true }]
			},
			{
				name: "tag",
				source: "declared",
				primaryKey: ["id"],
				fields: [field("id"), field("owner_id"), field("backup_id")]
			}
		],
		relations: [],
		refs: [
			{
				name: "fk_tag_owner_id_agency",
				fromCollection: "tag",
				fromColumn: "owner_id",
				toCollection: "agency",
				toColumn: "id",
				onDelete: "cascade",
				onUpdate: "restrict",
				source: "declared"
			}
		]
	};
	const ddl = (source: string, withSchema = schema): string =>
		ddlText(
			lowerDDL(
				parse(tokenize(source)) as import("../parser/ast").DDLStatement,
				withSchema
			)
		).text;

	it("FK posée NO ACTION, désactivée, actions en propriété ; triggers des deux tables, dans une transaction", () => {
		const text = ddl(
			"add ref (backup_id) references agency.id on delete set null on update cascade into tag"
		);
		expect(text).toContain(
			"ADD CONSTRAINT [fk_tag_backup_id_agency] FOREIGN KEY ([backup_id]) REFERENCES [dbo].[agency] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION"
		);
		expect(text).toContain(
			"ALTER TABLE [dbo].[tag] NOCHECK CONSTRAINT [fk_tag_backup_id_agency];"
		);
		expect(text).toContain(
			`EXEC sys.sp_addextendedproperty @name = N'${MSSQL_EMULATED_REF_PROPERTY}', @value = N'{"onDelete":"set-null","onUpdate":"cascade"}'`
		);
		expect(
			text.startsWith("SET NOCOUNT ON;\nSET XACT_ABORT ON;\nBEGIN TRAN;")
		).toBe(true);
		expect(text.endsWith("COMMIT;")).toBe(true);
		for (const trigger of [
			"snql_tag_check",
			"snql_agency_delete",
			"snql_agency_update"
		]) {
			expect(text).toContain(
				`IF OBJECT_ID(N'[dbo].[${trigger}]', N'TR') IS NOT NULL DROP TRIGGER [dbo].[${trigger}];`
			);
			expect(text).toContain(`EXEC (N'CREATE TRIGGER [dbo].[${trigger}] ON `);
		}
		// Valeur écrite absente de la table référencée : refusée.
		expect(text).toContain(
			"IF UPDATE([backup_id]) AND EXISTS (SELECT 1 FROM inserted AS i WHERE i.[backup_id] IS NOT NULL AND NOT EXISTS (SELECT 1 FROM [dbo].[agency] AS r WHERE r.[id] = i.[backup_id]))"
		);
		// Suppression : mise à null des dépendants.
		expect(text).toContain(
			"UPDATE x SET x.[backup_id] = NULL FROM [dbo].[tag] AS x JOIN deleted AS d ON x.[backup_id] = d.[id];"
		);
		// Changement de clé : une ligne, ou plusieurs reliées par une clé inchangée.
		expect(text).toContain("ELSE IF NOT (UPDATE([code]))");
		expect(text).toContain("JOIN inserted AS i ON i.[code] = d.[code]");
	});

	it("auto-référence en cascade : suppression de niveau en niveau", () => {
		const text = ddl(
			"create table node { id: int, parent_id: int nullable ref self.id on delete cascade, primary key (id) }"
		);
		expect(text).toContain(
			"WHILE @@ROWCOUNT > 0 DELETE x OUTPUT DELETED.[id] INTO @k0 FROM [dbo].[node] AS x WHERE EXISTS (SELECT 1 FROM @k0 AS s WHERE s.k = x.[parent_id]);"
		);
	});

	it("FK compensée retirée : triggers retirés, aucun recréé", () => {
		const emulated = {
			...schema,
			refs: [
				...(schema.refs ?? []),
				{
					name: "fk_tag_backup_id_agency",
					fromCollection: "tag",
					fromColumn: "backup_id",
					toCollection: "agency",
					toColumn: "id",
					onDelete: "set-null" as const,
					onUpdate: "restrict" as const,
					source: "declared" as const,
					emulated: true
				}
			]
		};
		const text = ddl("drop ref fk_tag_backup_id_agency from tag", emulated);
		expect(text).toContain("DROP TRIGGER [dbo].[snql_agency_delete];");
		expect(text).not.toContain("CREATE TRIGGER");
	});

	it("dépendants retirés puis recréés (D9) : une FK désactivée le reste, avec sa propriété", () => {
		const text = ddl("alter column tag.backup_id set not null");
		expect(text).toContain(
			"CASE WHEN fk.is_disabled = 1 THEN N' WITH NOCHECK' ELSE N' WITH CHECK' END"
		);
		expect(text).toContain(
			`N'EXEC sys.sp_addextendedproperty @name = N''${MSSQL_EMULATED_REF_PROPERTY}''`
		);
	});

	it("écriture sur une table à trigger : OUTPUT … INTO, lignes relues par clé ; suppression copiée avant", () => {
		const triggered = {
			...schema,
			collections: schema.collections.map((c) =>
				c.name === "tag"
					? { ...c, triggers: ["insert", "update", "delete"] as const }
					: c
			)
		};
		const write = (source: string, withSchema = triggered): string => {
			const native = getMapper("mssql").mapMutation(
				lowerMutation(
					parse(tokenize(source)) as Parameters<typeof lowerMutation>[0],
					withSchema
				)
			);
			return native.kind === "sql" ? native.text : "";
		};
		const insert = write("add { id: 1, owner_id: 2 } into tag");
		expect(insert).toBe(
			"DECLARE @snql_keys TABLE ([id] sql_variant);\nINSERT INTO [tag] ([id], [owner_id]) OUTPUT INSERTED.[id] INTO @snql_keys VALUES (@p1, @p2);\nSELECT [__sqlnest_row].* FROM [tag] AS [__sqlnest_row] WHERE EXISTS (SELECT 1 FROM @snql_keys AS [__sqlnest_key] WHERE [__sqlnest_key].[id] = [__sqlnest_row].[id]);"
		);
		expect(write("remove from tag where id = 1")).toBe(
			"IF OBJECT_ID(N'tempdb..#snql_rows') IS NOT NULL DROP TABLE #snql_rows;\nSELECT * INTO #snql_rows FROM [tag] WHERE [id] = @p1;\nDELETE [__sqlnest_row] FROM [tag] AS [__sqlnest_row] WHERE EXISTS (SELECT 1 FROM #snql_rows AS [__sqlnest_key] WHERE [__sqlnest_key].[id] = [__sqlnest_row].[id]);\nSELECT * FROM #snql_rows;\nDROP TABLE #snql_rows;"
		);
		expect(write("add { id: 1, owner_id: 2 } into tag", schema)).toContain(
			"OUTPUT INSERTED.* VALUES"
		);
	});
});
