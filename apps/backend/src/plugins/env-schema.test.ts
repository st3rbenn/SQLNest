import { describe, expect, it } from "vitest";

/**
 * Smoke test — vérifie que toutes les regex du JSON schema de @fastify/env
 * compilent sous V8/ECMAScript. Prévient la régression du crash boot
 * `(?i:...)` Perl-only (commit 327ea21).
 */
describe("env.schema regex patterns compile under V8", () => {
	const patterns: Record<string, string> = {
		AUTH_SECRET:
			"^(?!.*[Cc][Hh][Aa][Nn][Gg][Ee][Mm][Ee])(?!.*[Rr][Ee][Pp][Ll][Aa][Cc][Ee])(?!.*[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]).*$",
		DATABASE_URL: "^postgres(ql)?://"
	};

	for (const [name, pattern] of Object.entries(patterns)) {
		it(`${name} pattern compiles`, () => {
			expect(() => new RegExp(pattern)).not.toThrow();
		});

		it(`${name} pattern matches expected input`, () => {
			const re = new RegExp(pattern);
			if (name === "AUTH_SECRET") {
				expect(re.test("aVerySecure64CharRandomSecret1234")).toBe(true);
				expect(re.test("changeme")).toBe(false);
				expect(re.test("CHANGEME")).toBe(false);
				expect(re.test("replace")).toBe(false);
				expect(re.test("REPLACE")).toBe(false);
				expect(re.test("placeholder")).toBe(false);
				expect(re.test("my-placeholder-secret")).toBe(false);
			}
			if (name === "DATABASE_URL") {
				expect(re.test("postgres://user:pass@localhost/db")).toBe(true);
				expect(re.test("postgresql://user:pass@localhost/db")).toBe(true);
				expect(re.test("mysql://user:pass@localhost/db")).toBe(false);
			}
		});
	}
});
