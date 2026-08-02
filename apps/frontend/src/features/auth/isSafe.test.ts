import { describe, expect, it } from "vitest";
import { isSafeCallback, isSafePath } from "./isSafe";

/**
 * Tests des deux gardes anti-open-redirect. Contrat identique : accepter
 * un chemin interne relatif, rejeter tout ce qui pourrait devenir absolu
 * ou cross-origin dans un browser.
 *
 * `isSafePath` accepte `unknown` (guard TypeScript is-narrowing) —
 * `isSafeCallback` accepte `string` (le caller le sait déjà). Les cas
 * pathologiques (null, undefined, nombres, objets) ne concernent donc que
 * `isSafePath` — on garde une seule suite `describe` pour partager les
 * cas de contenu.
 */
describe("isSafePath / isSafeCallback — anti open-redirect", () => {
	const validPaths = [
		"/",
		"/canvas",
		"/query",
		"/query?engine=postgres",
		"/verify-email?token=abc",
		"/reset-password?token=xyz&other=1",
		"/path/with/many/segments",
		"/utf-8/café",
		"/#fragment"
	];
	for (const p of validPaths) {
		it(`accepte le chemin interne "${p}"`, () => {
			expect(isSafePath(p)).toBe(true);
			expect(isSafeCallback(p)).toBe(true);
		});
	}

	const rejectedForBoth: string[] = [
		"",
		"canvas",
		"//evil.com",
		"//evil.com/path",
		"/\\evil.com",
		"http://evil.com",
		"https://evil.com/path",
		"javascript:alert(1)",
		"data:text/html,<script>",
		"about:blank",
		"file:///etc/passwd",
		"mailto:x@example.com",
		"ftp://evil.com",
		"vbscript:msgbox(1)"
	];
	for (const p of rejectedForBoth) {
		it(`refuse "${p}"`, () => {
			expect(isSafePath(p)).toBe(false);
			expect(isSafeCallback(p)).toBe(false);
		});
	}

	it("isSafePath refuse les non-strings (garde de type)", () => {
		expect(isSafePath(undefined)).toBe(false);
		expect(isSafePath(null)).toBe(false);
		expect(isSafePath(42)).toBe(false);
		expect(isSafePath({ href: "/x" })).toBe(false);
		expect(isSafePath(["/", "/canvas"])).toBe(false);
		expect(isSafePath(true)).toBe(false);
	});

	it("isSafePath narrow le type en `string` en succès", () => {
		const raw: unknown = "/canvas";
		if (isSafePath(raw)) {
			// Doit compiler — sans narrowing, `raw` reste `unknown` et
			// `raw.startsWith(...)` échouerait au type-check.
			expect(raw.startsWith("/")).toBe(true);
		} else {
			throw new Error("expected isSafePath narrowing to succeed");
		}
	});
});
