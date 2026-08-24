import { describe, expect, it } from "vitest";
import { classifySchemaEventsUsage } from "./useRunQuery";

describe("classifySchemaEventsUsage", () => {
	it("détecte une lecture directe", () => {
		expect(classifySchemaEventsUsage("find schema_events pick id").kind).toBe(
			"read"
		);
		expect(classifySchemaEventsUsage("get schema_events limit 10").kind).toBe(
			"read"
		);
	});

	it("détecte une lecture avec espaces / newlines", () => {
		expect(
			classifySchemaEventsUsage("\n  find schema_events\n  pick id\n").kind
		).toBe("read");
	});

	it("refuse un insert sur schema_events", () => {
		expect(
			classifySchemaEventsUsage('add {checksum: "x"} into schema_events').kind
		).toBe("write");
		expect(
			classifySchemaEventsUsage("create {checksum: null} into schema_events")
				.kind
		).toBe("write");
	});

	it("refuse un delete sur schema_events", () => {
		expect(
			classifySchemaEventsUsage("remove from schema_events where id = 1").kind
		).toBe("write");
	});

	it("refuse un update sur schema_events", () => {
		expect(
			classifySchemaEventsUsage(
				"update schema_events set checksum = 'x' where id = 1"
			).kind
		).toBe("write");
		expect(
			classifySchemaEventsUsage("edit schema_events set checksum = 'x'").kind
		).toBe("write");
	});

	it("ne match pas un ident qui commence par schema_events (préfixe strict)", () => {
		expect(
			classifySchemaEventsUsage("find schema_events_v2 pick id").kind
		).toBe("none");
	});

	it("ne match pas une DB user table normale", () => {
		expect(
			classifySchemaEventsUsage("find users pick id").kind
		).toBe("none");
		expect(
			classifySchemaEventsUsage('add {name: "x"} into users').kind
		).toBe("none");
	});

	it("ne match pas quand schema_events est ailleurs dans un where", () => {
		// Faux positif acceptable pour v1 : `find users where name = "schema_events"`
		// tombe en "none" car le regex read cible strictement après le verbe.
		expect(
			classifySchemaEventsUsage(
				'find users where name = "schema_events"'
			).kind
		).toBe("none");
	});
});
