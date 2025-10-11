export type SNQLSelectToken = "get" | "find" | "show" | "fetch";
export type SNQLInsertToken = "add" | "inject" | "append" | "create";
export type SNQLUpdateToken = "update" | "modify" | "edit" | "patch" | "change";
export type SNQLDeleteToken = "remove" | "erase" | "obliterate" | "clear";
export type SNQLToken =
	| SNQLSelectToken
	| SNQLInsertToken
	| SNQLUpdateToken
	| SNQLDeleteToken;
export const SNQLSelectTokens: SNQLSelectToken[] = [
	"get",
	"find",
	"show",
	"fetch",
];
export const SNQLInsertTokens: SNQLInsertToken[] = [
	"add",
	"inject",
	"append",
	"create",
];
export const SNQLUpdateTokens: SNQLUpdateToken[] = [
	"update",
	"modify",
	"edit",
	"patch",
	"change",
];
export const SNQLDeleteTokens: SNQLDeleteToken[] = [
	"remove",
	"erase",
	"obliterate",
	"clear",
];
export const SNQLTokens: SNQLToken[] = [
	...SNQLSelectTokens,
	...SNQLInsertTokens,
	...SNQLUpdateTokens,
	...SNQLDeleteTokens,
];
