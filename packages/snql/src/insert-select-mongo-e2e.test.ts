/**
 * Sibling parité Mongo pour insert-select. Mirror de
 * insert-select-e2e.test.ts (oracle PG utilise `INSERT ... SELECT`).
 * Mongo compile via aggregate + $merge dans une collection cible.
 *
 * Pipeline attendu : [...source pipeline stages..., $merge{into: target,
 * whenMatched: 'fail', whenNotMatched: 'insert'}].
 *
 * (session tx obligatoire, Mongo 5.0+ RS) enforced côté adapter runtime
 * (adapter.ts #executeWrite refuse hors session).
 */

import { describe, expect, it } from "vitest";
import { mongoWrite } from "./index";

describe("insert-select Mongo pipeline shape", () => {
	it("add (find …) into T → pipeline source + $merge", () => {
		const write = mongoWrite("add (find users pick id, email) into archive");
		expect(write.kind).toBe("mongo-write");
		expect(write.op).toBe("insert-select-agg-merge");
		if (write.op !== "insert-select-agg-merge") throw new Error();
		expect(write.collection).toBe("archive");
		expect(write.sourceCollection).toBe("users");
		const pipeline = write.pipeline;
		// Dernière stage = $merge terminal
		const mergeStage = pipeline[pipeline.length - 1] as {
			$merge: { into: string; whenMatched: string; whenNotMatched: string };
		};
		expect(mergeStage.$merge.into).toBe("archive");
		expect(mergeStage.$merge.whenMatched).toBe("fail");
		expect(mergeStage.$merge.whenNotMatched).toBe("insert");
	});

	it("add (find … where … pick …) into T → source pipeline filtre + $merge", () => {
		const write = mongoWrite(
			'add (find users where inactive = true pick id, email) into archive'
		);
		if (write.op !== "insert-select-agg-merge") throw new Error();
		const pipeline = write.pipeline;
		// Le pipeline source contient $match (le predicate) + $project (le pick)
		// et se termine par $merge terminal.
		expect(pipeline.some((s) => "$match" in s)).toBe(true);
		expect(pipeline.some((s) => "$project" in s)).toBe(true);
		expect(pipeline[pipeline.length - 1]).toHaveProperty("$merge");
	});

	it("pick alias → colonnes cibles renommées via $project", () => {
		const write = mongoWrite(
			"add (find users pick id as tgt_id, email as tgt_email) into archive"
		);
		if (write.op !== "insert-select-agg-merge") throw new Error();
		// Le pick avec alias est déjà géré par le codegen aggregate normal ;
		// les $project renomment les cols avant le $merge.
		const pipeline = write.pipeline;
		const projectStage = pipeline.find((s) => "$project" in s) as {
			$project: Record<string, unknown>;
		};
		expect(projectStage.$project).toHaveProperty("tgt_id");
		expect(projectStage.$project).toHaveProperty("tgt_email");
	});

	it("$merge policy fail/insert (INSERT semantics, pas replace)", () => {
		const write = mongoWrite("add (find users pick id) into archive");
		if (write.op !== "insert-select-agg-merge") throw new Error();
		const mergeStage = write.pipeline[write.pipeline.length - 1] as {
			$merge: { whenMatched: string; whenNotMatched: string };
		};
		// whenMatched='fail' = duplicate key → erreur (comme INSERT PG sans ON CONFLICT).
		// whenNotMatched='insert' = insertion normale (comportement primaire).
		expect(mergeStage.$merge.whenMatched).toBe("fail");
		expect(mergeStage.$merge.whenNotMatched).toBe("insert");
	});
});
