import { describe, expect, it } from "vitest";
import { renderHelp } from "./help";
import { COMMANDS } from "./registry";

/** Aide attendue, au caractère près : une commande qui change son aide
 *  met ce texte à jour. */
const EXPECTED_HELP = `sqlnest — CLI SQLNest (tunnel local vers ta DB Postgres).

Usage :
  sqlnest connect                          Device flow interactif (menu ↑↓ si ≥2 DSN)
  sqlnest connect --connection <name>      Force la DSN locale à servir (skip menu)
  sqlnest connect --no-browser             Idem, sans ouverture browser
  sqlnest connect --token <sn> --name <n>  CI mode (Bearer sn_...)
  sqlnest logout --all                     Retire tous les tunnels locaux
  sqlnest logout --tunnel <id>             Retire un tunnel local
  sqlnest ping --tunnel <name>             Ping local DSN (diagnostic)
  sqlnest add-connection                   Bases trouvées (projet courant, Docker), chaîne collée ou saisie
  sqlnest add-connection --url <chaîne>    URL, JDBC, ADO.NET ou libpq (⚠ visible dans ps aux / historique shell)
  sqlnest add-connection … --name <n>      Nom de la connexion (proposé d'après la base sinon)
  sqlnest add-connection … --force         Écrase sans demander confirmation
  sqlnest add-connection … --no-test       Enregistre sans tester la connexion
  sqlnest list-connections                 Liste les DSN locales (sans les credentials)
  sqlnest revoke-connection --name <n>     Retire une DSN locale (avec confirm)
  sqlnest revoke-connection --name <n> --yes  Skip la confirmation
  sqlnest --help                           Affiche cette aide
  sqlnest --version                        Affiche la version
`;

describe("renderHelp", () => {
	it("rend l'aide de sqlnest", () => {
		expect(renderHelp(COMMANDS)).toBe(EXPECTED_HELP);
	});
});
