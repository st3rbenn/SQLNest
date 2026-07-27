import type { Row } from "./index";
import { compensate, compile, planFor } from "./index";

// JSON.stringify ne sait pas sérialiser un bigint.
const stringify = (value: unknown): string =>
	JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}n` : v));

// --- Codegen dual-moteur (Slices 1–2) ---
console.log("=== Codegen : 1 SNQL → 2 moteurs natifs ===\n");
const reads = [
	`get users | where age > 30 and status = "active" | sort -created_at | limit 10 offset 20 | pick name, email`,
	`get users | limit 5 | where age > 30`,
	`get users | with orders on id = user_id | pick name, orders`
];
for (const source of reads) {
	console.log("SNQL :", source);
	const pg = compile(source, { engine: "postgres" }).native;
	if (pg.kind === "sql") {
		console.log("  PG    :", pg.text, "  params:", stringify(pg.params));
	}
	const mongo = compile(source, { engine: "mongodb" }).native;
	if (mongo.kind === "mongo") {
		console.log(
			`  Mongo : db.${mongo.collection}.aggregate(${stringify(mongo.pipeline)})`
		);
	}
	console.log("");
}

// --- Planner capability-aware : pushdown vs compensation (Slice 3) ---
console.log("=== Planner : pushdown vs compensation ===\n");
const query = "get users | where age > 30 | sort -age | limit 2";
console.log("SNQL :", query, "\n");
for (const engine of ["postgres", "kv"]) {
	const physical = planFor(query, engine);
	const comp = physical.compensation.map((o) => o.op).join(", ") || "∅";
	console.log(
		`  ${engine.padEnd(9)} fullyPushed=${physical.fullyPushed}  compensation=[${comp}]`
	);
}
console.log("");

// KV pousse scan+filter (age>30) ; le runtime compense sort+limit sur les rows renvoyées.
const kv = planFor(query, "kv");
const kvReturned: Row[] = [
	{ name: "Bob", age: 40 },
	{ name: "Cy", age: 35 },
	{ name: "Do", age: 55 }
];
console.log("  KV renvoie (scan+filter poussés) :", stringify(kvReturned));
console.log(
	`  → runtime compense [${kv.compensation.map((o) => o.op).join(", ")}] :`,
	stringify(compensate(kv.compensation, kvReturned))
);
