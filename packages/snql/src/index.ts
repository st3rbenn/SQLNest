import pino from "pino";
import { MySQLParserWrapper } from "./Parser/MySQLParserWrapper";

export const logger = pino({
	transport: {
		target: "pino-pretty",
		options: {
			colorize: true,
		},
	},
});

MySQLParserWrapper.instance().parseQuery("SELECT id FROM users");

// const mysqlParser = new parser({
// 	version: "5.7.7",
// 	mode: SqlMode.AnsiQuotes,
// });

// const result = mysqlParser.parse("SELECT id FROM users");

// const queryType = mysqlParser.getQueryType(result);
// console.log(queryType === MySQLQueryType.QtSelect); // true
