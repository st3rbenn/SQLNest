import { describe, expect, it } from "vitest";
import { compile, getMapper } from "../index";
import { lowerMutation, lowerRaw } from "../ir/lower";
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

describe("codegen mssql — slices pas encore câblées (refus typés)", () => {
	it("mapMutation → erreur typée M/4 (defense-in-depth sous le gate planner)", () => {
		const stmt = parse(tokenize(`edit users where id = 1 set name = "x"`));
		if (stmt.operation !== "update") throw new Error("update attendu");
		expect(() =>
			getMapper("mssql").mapMutation(lowerMutation(stmt))
		).toThrow(/M\/4/);
	});
});
