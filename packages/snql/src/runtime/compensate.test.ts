import { describe, expect, it } from "vitest";
import type { Row } from "../index";
import { compensate, compile, plan } from "../index";
import type { Capability } from "../ir/plan";

// Un moteur fictif qui ne sait QUE scanner → tout le reste est compensé,
// ce qui permet de tester l'exécuteur runtime sur chaque opérateur.
const scanOnly = {
	engine: "scan-only",
	supports: new Set<Capability>(["scan"])
};

function compensationOf(source: string) {
	const logical = compile(source, { engine: "postgres" }).plan;
	return plan(logical, scanOnly).compensation;
}

function run(source: string, rows: readonly Row[]): Row[] {
	return compensate(compensationOf(source), rows);
}

const people: Row[] = [
	{ id: 1, name: "Bob", age: 40, city: "Paris" },
	{ id: 2, name: "Al", age: 20, city: "Lyon" },
	{ id: 3, name: "Cy", age: 30, city: null },
	{ id: 4, name: "Do", age: 55, city: "Paris" }
];

describe("compensate — opérateurs runtime", () => {
	it("filter + sort desc + limit", () => {
		const out = run("get t | where age > 25 | sort -age | limit 2", people);
		expect(out.map((r) => r.name)).toEqual(["Do", "Bob"]);
	});

	it("project ne garde que les champs demandés", () => {
		expect(run("get t | pick name, city", [people[0] as Row])).toEqual([
			{ name: "Bob", city: "Paris" }
		]);
	});

	it("accès à un champ imbriqué (dotted path)", () => {
		const rows: Row[] = [
			{ id: 1, address: { city: "Paris" } },
			{ id: 2, address: { city: "Lyon" } }
		];
		expect(
			run(`get t | where address.city = "Paris"`, rows).map((r) => r.id)
		).toEqual([1]);
	});
});

describe("compensate — logique à 3 valeurs (3VL, parité SQL)", () => {
	it("comparaison impliquant NULL → UNKNOWN → exclu du filtre", () => {
		// Cy a city=null : `city = "Paris"` est UNKNOWN, donc Cy est exclu (pas gardé).
		expect(
			run(`get t | where city = "Paris"`, people).map((r) => r.name)
		).toEqual(["Bob", "Do"]);
	});

	it("comparaison numérique sur champ NULL → exclu", () => {
		const rows: Row[] = [
			...people,
			{ id: 5, name: "En", age: null, city: "Nice" }
		];
		expect(run("get t | where age > 25", rows).map((r) => r.name)).toEqual([
			"Bob",
			"Cy",
			"Do"
		]);
	});

	it("= null → IS NULL (garde uniquement les null)", () => {
		expect(run("get t | where city = null", people).map((r) => r.name)).toEqual(
			["Cy"]
		);
	});

	it("in [...] : NULL exclu (UNKNOWN)", () => {
		expect(
			run(`get t | where city in ["Paris", "Nice"]`, people).map((r) => r.name)
		).toEqual(["Bob", "Do"]);
	});

	it("like matche via regex (dotall, ancré)", () => {
		expect(
			run(`get t | where name like "B%"`, people).map((r) => r.name)
		).toEqual(["Bob"]);
	});

	it("comparaison cross-type : nombre vs chaîne numérique (numérique, pas lexicographique)", () => {
		const rows: Row[] = [{ age: "20" }, { age: "150" }, { age: "9" }];
		expect(run("get t | where age > 100", rows).map((r) => r.age)).toEqual([
			"150"
		]);
	});

	it("NULL IN () → FALSE (donc not(in []) garde tout, même les null)", () => {
		expect(
			run("get t | where not city in []", people).map((r) => r.name)
		).toEqual(["Bob", "Al", "Cy", "Do"]);
	});
});

describe("compensate — ordre des NULL dans le tri (parité Postgres)", () => {
	it("NULL en dernier en ASC, en premier en DESC", () => {
		const rows: Row[] = [{ v: 3 }, { v: null }, { v: 1 }];
		expect(run("get t | sort v", rows).map((r) => r.v)).toEqual([1, 3, null]);
		expect(run("get t | sort -v", rows).map((r) => r.v)).toEqual([null, 3, 1]);
	});

	it("tri cross-type numérique (nombre + chaîne numérique)", () => {
		const rows: Row[] = [{ v: "100" }, { v: 9 }, { v: "20" }];
		expect(run("get t | sort v", rows).map((r) => r.v)).toEqual([
			9,
			"20",
			"100"
		]);
	});
});
