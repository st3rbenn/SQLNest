import MySQLParser, {
	MySQLQueryType,
	ParseResult,
	SqlMode,
} from "ts-mysql-parser";
const ParserMod = await import("ts-mysql-parser");
const Parser = ParserMod.default;
import { logger } from "..";

export class MySQLParserWrapper {
	private parser: MySQLParser;

	public static _instance: MySQLParserWrapper | null = null;
	public static instance(): MySQLParserWrapper {
		if (!this._instance) {
			this._instance = new MySQLParserWrapper();
			return this._instance;
		}
		return this._instance;
	}

	constructor(mode: SqlMode = SqlMode.AnsiQuotes) {
		logger.info("Creating new MySQLParser instance");
		this.parser = new Parser({ mode });
	}

	public parseQuery(query: string) {
		const result = this.parser.parse(query);
		const queryType = this.parser.getQueryType(result);

		switch (queryType) {
			case MySQLQueryType.QtSelect:
				this.parseSelectQuery(result);
				break;
			default:
				logger.warn("Unknown query type: " + queryType);
		}
	}

	public parseSelectQuery(result: ParseResult) {
		logger.info("Parsed a SELECT query");

		console.log(result);
		// const tableRef = this.parser.getNodeAtOffset(result, 18);
		// console.log(tableRef); // table 'users'
		// const columnRef = this.parser.getNodeAtOffset(result, 7);
		// console.log(columnRef); // column 'id'
	}
}
