import { describe, expect, it } from "vitest";
import {
	fieldList,
	parseArguments,
	parseAttributes,
	renameInFieldList,
	renderArguments,
	renderAttributes,
	withArgument
} from "./attributes";

describe("attributs Prisma", () => {
	it("parenthèses et chaînes imbriquées, commentaire de fin gardé", () => {
		const line = parseAttributes(
			'@id @default(dbgenerated("gen_random_uuid()")) @map("a)b, c") @db.Uuid // clé'
		);
		expect(line.attributes).toEqual([
			{ name: "@id" },
			{ name: "@default", args: 'dbgenerated("gen_random_uuid()")' },
			{ name: "@map", args: '"a)b, c"' },
			{ name: "@db.Uuid" }
		]);
		expect(line.tail).toBe("// clé");
		expect(renderAttributes(line)).toBe(
			'@id @default(dbgenerated("gen_random_uuid()")) @map("a)b, c") @db.Uuid // clé'
		);
	});

	it("arguments positionnels et nommés, listes de champs", () => {
		const args = parseArguments(
			'"Owner", fields: [a, b], references: [id], onDelete: Cascade'
		);
		expect(args).toEqual([
			{ value: '"Owner"' },
			{ key: "fields", value: "[a, b]" },
			{ key: "references", value: "[id]" },
			{ key: "onDelete", value: "Cascade" }
		]);
		expect(renderArguments(withArgument(args, "onDelete", undefined))).toBe(
			'"Owner", fields: [a, b], references: [id]'
		);
		expect(renderArguments(withArgument(args, "map", '"x"'))).toBe(
			'"Owner", fields: [a, b], references: [id], onDelete: Cascade, map: "x"'
		);
		expect(fieldList("[a, b(sort: Desc)]")).toEqual(["a", "b"]);
		expect(renameInFieldList("[a, b(sort: Desc)]", "b", "c")).toBe(
			"[a, c(sort: Desc)]"
		);
	});
});
