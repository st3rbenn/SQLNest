import { describe, expect, it } from "vitest";
import { compile, getMapper } from "../index";
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
			`SELECT CAST(FLOOR(DATEDIFF_BIG(millisecond, [started_at], [ended_at]) / 3600000.0) AS int) AS [h] FROM [sessions]`
		);
	});

	it("date_trunc week → iso_week (indépendant de @@DATEFIRST)", () => {
		const { text } = sql(
			`get events pick date_trunc("week", created_at) as w`
		);
		expect(text).toBe(
			`SELECT DATETRUNC(iso_week, [created_at]) AS [w] FROM [events]`
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
			`IF OBJECT_ID(@p1, N'U') IS NOT NULL SELECT [name], (SELECT COUNT(*) FROM OPENJSON([members])) AS members_count FROM [dbo].[_snql_enums] ORDER BY [name] ASC ELSE SELECT TOP 0 CAST(NULL AS nvarchar(4000)) AS [name], CAST(NULL AS int) AS members_count`
		);
		expect(params).toEqual(["dbo._snql_enums"]);
	});

	it("describe enum → OPENJSON positions 1..N", () => {
		const { text, params } = introspectSql("describe enum statut");
		expect(text).toContain("CROSS APPLY OPENJSON([members]) j");
		expect(text).toContain("CAST(j.[key] AS int) + 1 AS position");
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
			`CREATE TABLE [users] ([id] nvarchar(450) NOT NULL, [age] int NOT NULL, [bio] nvarchar(max), [active] bit NOT NULL DEFAULT 1, PRIMARY KEY ([id]))`
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
			`IF OBJECT_ID(N'[dbo].[t]', N'U') IS NULL CREATE TABLE [t] ([id] int NOT NULL, PRIMARY KEY ([id]))`
		);
	});

	it("create table avec ref → FK inline, restrict → NO ACTION", () => {
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
		expect(text).toContain(
			`[user_id] int NOT NULL CONSTRAINT [fk_orders_user_id] REFERENCES [users] ([id]) ON DELETE NO ACTION ON UPDATE NO ACTION`
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
			`ALTER TABLE [users] ADD [note] nvarchar(max) DEFAULT N'aucune' WITH VALUES`
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
			`IF COL_LENGTH(N'[dbo].[users]', N'age') IS NULL ALTER TABLE [users] ADD [age] int NOT NULL`
		);
	});

	it("add unique index + if not exists guard sys.indexes", () => {
		const { text } = ddlText({
			op: "ddl",
			kind: "add-unique-index",
			target: "users",
			fields: ["email"],
			name: "unique_users_email",
			ifNotExists: true
		});
		expect(text).toBe(
			`IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'unique_users_email' AND object_id = OBJECT_ID(N'[users]')) CREATE UNIQUE INDEX [unique_users_email] ON [users] ([email])`
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
		expect(text).toBe(`DROP INDEX [idx_users_email] ON [users]`);
	});

	it("drop table / drop column / drop ref", () => {
		expect(
			ddlText({
				op: "ddl",
				kind: "drop-table",
				target: "tmp",
				ifExists: true
			}).text
		).toBe(`DROP TABLE IF EXISTS [tmp]`);
		expect(
			ddlText({
				op: "ddl",
				kind: "drop-column",
				target: "users",
				column: "note",
				ifExists: false
			}).text
		).toBe(`ALTER TABLE [users] DROP COLUMN [note]`);
		expect(
			ddlText({
				op: "ddl",
				kind: "drop-ref",
				target: "orders",
				name: "fk_orders_user_id",
				ifExists: false
			}).text
		).toBe(`ALTER TABLE [orders] DROP CONSTRAINT [fk_orders_user_id]`);
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
			`IF OBJECT_ID(N'[dbo].[_snql_enums]', N'U') IS NULL CREATE TABLE [dbo].[_snql_enums] ([name] nvarchar(128) NOT NULL PRIMARY KEY, [members] nvarchar(max) NOT NULL); INSERT INTO [dbo].[_snql_enums] ([name], [members]) VALUES (@p1, @p2)`
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
			`UPDATE [dbo].[_snql_enums] SET [members] = JSON_MODIFY([members], 'append $', @p2) WHERE [name] = @p1 AND NOT EXISTS (SELECT 1 FROM OPENJSON([members]) WHERE [value] = @p2)`
		);
		expect(params).toEqual(["statut", "archive"]);
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
