import Parser, { SqlMode, MySQLQueryType } from "ts-mysql-parser";
import { logger } from "..";

export class MySQLParserWrapper {
	private parser: Parser;

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
				logger.info("Parsed a SELECT query");
				break;
			default:
				logger.warn("Unknown query type: " + queryType);
		}
	}
}
