import { describe, expect, it } from "vitest";
import { renderHelp } from "./help";
import { COMMANDS } from "./registry";

/** Aide attendue, au caractère près : une commande qui change son aide
 *  met ce texte à jour. */
const EXPECTED_HELP = `sqlnest — CLI SQLNest (tunnel local vers tes bases).

Usage :
  sqlnest connect                          Sert une connexion : celle du projet relié, sinon menu
  sqlnest connect --connection <name>      Sert cette connexion, sans menu
  sqlnest connect --no-browser             Idem, sans ouvrir le navigateur
  sqlnest connect --token <sn> --name <n>  Mode CI (Bearer sn_...)
  sqlnest logout --all                     Retire tous les tunnels locaux
  sqlnest logout --tunnel <id>             Retire un tunnel local
  sqlnest ping --tunnel <name>             Teste une connexion locale (diagnostic)
  sqlnest add-connection                   Bases trouvées (projet courant, Docker), chaîne collée ou saisie
  sqlnest add-connection --url <chaîne>    URL, JDBC, ADO.NET ou libpq (⚠ visible dans ps aux / historique shell)
  sqlnest add-connection … --name <n>      Nom de la connexion (proposé d'après la base sinon)
  sqlnest add-connection … --force         Écrase sans demander confirmation
  sqlnest add-connection … --no-test       Enregistre sans tester la connexion
  sqlnest link-project                     Relie le projet du dossier courant (ORM et base détectés)
  sqlnest link-project <connexion> <dossier>  Relie ce dossier à cette connexion
  sqlnest link-project … --no-apply        Migrations écrites sans toucher la base (déployée par la CI)
  sqlnest list-connections                 Liste les connexions locales (sans secret)
  sqlnest revoke-connection --name <n>     Retire une connexion locale (avec confirmation)
  sqlnest revoke-connection --name <n> --yes  Sans confirmation
  sqlnest --help                           Affiche cette aide
  sqlnest --version                        Affiche la version
`;

describe("renderHelp", () => {
	it("rend l'aide de sqlnest", () => {
		expect(renderHelp(COMMANDS)).toBe(EXPECTED_HELP);
	});
});
