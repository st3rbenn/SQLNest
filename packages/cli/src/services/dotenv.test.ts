// biome-ignore-all lint/suspicious/noTemplateCurlyInString: les chaînes `${VAR}` sont ce que ces tests lisent
import { describe, expect, it } from "vitest";
import { parseDotenv } from "./dotenv";

describe("parseDotenv", () => {
	it("clés, export, commentaires, quotes", () => {
		expect(
			parseDotenv(
				[
					"# commentaire",
					"",
					"DATABASE_URL=postgres://u:p@localhost:5436/apollon-db # inline",
					'export SHADOW="postgres://u:p@localhost/shadow"',
					"LITERAL='a $B # pas un commentaire'",
					"EMPTY=",
					"not a pair"
				].join("\n")
			)
		).toEqual({
			DATABASE_URL: "postgres://u:p@localhost:5436/apollon-db",
			SHADOW: "postgres://u:p@localhost/shadow",
			LITERAL: "a $B # pas un commentaire",
			EMPTY: ""
		});
	});

	it("${AUTRE}, $AUTRE et défaut, depuis le fichier puis l'environnement", () => {
		expect(
			parseDotenv(
				[
					"DB_USER=lab",
					"DB_PASS=lab",
					"DATABASE_URL=postgres://${DB_USER}:$DB_PASS@${DB_HOST:-localhost}:${DB_PORT}/apollon",
					"PRICE=\\$5"
				].join("\n"),
				{ DB_PORT: "5440" }
			)
		).toMatchObject({
			DATABASE_URL: "postgres://lab:lab@localhost:5440/apollon",
			PRICE: "$5"
		});
	});

	it("guillemets : échappements et valeur sur plusieurs lignes ; CRLF", () => {
		expect(parseDotenv('A="x\\"y\\nz"\r\nB="ligne1\nligne2"\r\n')).toEqual({
			A: 'x"y\nz',
			B: "ligne1\nligne2"
		});
	});

	it("référence circulaire : vide plutôt qu'une boucle", () => {
		expect(parseDotenv("A=${B}\nB=${A}x")).toEqual({ A: "x", B: "x" });
	});
});
