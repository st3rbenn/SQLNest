import pino from "pino";

export const logger = pino({
	transport: {
		target: "pino-pretty",
		options: {
			colorize: true,
		},
	},
});

import MySQLParser, { SqlMode, MySQLQueryType } from "ts-mysql-parser";

const parser = new MySQLParser({
	version: "5.7.7",
	mode: SqlMode.AnsiQuotes,
});

const result = parser.parse("SELECT id FROM users");

const queryType = parser.getQueryType(result);
console.log(queryType === MySQLQueryType.QtSelect); // true

const tableRef = parser.getNodeAtOffset(result, 18);
console.log(tableRef); // table 'users'

const columnRef = parser.getNodeAtOffset(result, 7);
console.log(columnRef); // column 'id'
