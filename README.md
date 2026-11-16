# SQLNest

Un langage de requête, **SNQL**, et un **canvas** pour explorer, interroger et modifier des bases PostgreSQL, MongoDB et SQL Server. Les identifiants de tes bases ne quittent pas ta machine : un CLI local exécute les requêtes et parle à l'application par un tunnel.

## Comment ça marche

```
navigateur ──HTTPS──▶ backend ──WSS──▶ CLI local ──▶ ta base
 (canvas, console)     (relais)        (compile SNQL, exécute)
```

- Le **CLI** tourne chez toi. Il garde les chaînes de connexion dans `~/.sqlnest/`, compile le SNQL vers la requête native du moteur et l'exécute.
- Le **backend** relaie les requêtes et leurs résultats entre le navigateur et le CLI, sur un WebSocket sécurisé aux trames signées. Il ne reçoit jamais de chaîne de connexion. Il garde les comptes, les équipes et la disposition des canvas.
- Le **frontend** affiche le schéma, la console et les résultats.

## SNQL

Une seule syntaxe, compilée vers SQL (PostgreSQL, SQL Server) ou vers un pipeline d'agrégation (MongoDB).

```
find track where milliseconds > 300000 pick name, unit_price sort name limit 10

find track with one album on album_id = album.album_id pick name, album.title

find track group by album_id having count(*) > 5 pick album_id, count(*) as n

find album where album_id in (find track where milliseconds > 2000000 pick album_id) pick title

let long = find track where milliseconds > 2000000 pick track_id, name;
find long sort name limit 3
```

Écritures et transactions :

```
add { id: 1, label: "a" } into note
add { id: 1, label: "z" } into note on conflict (id) edit set label = "z"
update note where id = 1 set label = upper(label)
remove from note where id = 1

transaction {
	update note where id = 1 set label = "t1";
	update note where id = 2 set label = "t2"
}
```

Schéma :

```
create table note { id: int, primary key (id) }
add column label string nullable into note
add ref (author_id) references author.id into note
add unique index (label) into note
create enum status { "draft", "published" }
```

Ce qu'un moteur n'a pas est compensé à l'exécution plutôt que refusé : clés étrangères, valeurs par défaut et DDL sur MongoDB, enums sur SQL Server.

## Le canvas

- Le schéma en diagramme : tables, relations, frames pour regrouper, focus sur une table et ses voisines.
- Des consoles SNQL posées sur le canvas, avec diagnostics, plan et résultats.
- Un éditeur de schéma : un geste (ajouter une colonne, tracer une relation, créer une table, un index, un enum) devient une instruction SNQL, montrée avec son DDL avant d'être appliquée.
- Si un projet Prisma est relié à la connexion (`sqlnest link-project`), le changement s'écrit en migration Prisma et le modèle est mis à jour, au lieu de toucher la base directement.

## Utiliser SQLNest

Avec Node.js 22 ou plus :

```bash
npx @sqlnest/cli add-connection
```

```bash
npx @sqlnest/cli connect
```

`add-connection` propose les bases trouvées dans le projet courant et dans Docker, ou prend une chaîne de connexion. `connect` ouvre la page d'appairage, puis sert la connexion tant qu'il tourne. Le détail des commandes est dans [packages/cli/README.md](packages/cli/README.md).

## Développer

Prérequis : Node.js 22, pnpm, Docker.

```bash
pnpm install
```

```bash
cp .env.example .env
```

```bash
pnpm db:up
```

```bash
pnpm app:db:migrate
```

Puis, dans deux terminaux :

```bash
pnpm --filter @sqlnest/backend dev
```

```bash
pnpm --filter @sqlnest/frontend dev
```

Le frontend écoute sur `http://localhost:3000`, le backend sur `http://localhost:4000`. Le CLI depuis les sources, pointé sur le backend local :

```bash
./bin/sqlnest-dev connect
```

Les bases de démonstration et leurs ports sont décrits dans [infra/README.md](infra/README.md).

### Vérifier

```bash
pnpm type-check
```

```bash
pnpm test
```

Les tests d'intégration de l'engine se lancent quand `SNQL_TEST_PG_URL` et `SNQL_TEST_MONGO_URL` sont définis (voir `.env.example`) ; sans eux, ils sont sautés.

## Le dépôt

| Dossier | Rôle |
|-|-|
| `apps/frontend` | Application web : React, TanStack Router et Query, Mantine, CodeMirror |
| `apps/backend` | API : Fastify, Drizzle, Better Auth ; relais des tunnels |
| `packages/snql` | Le langage : lexer, parser, plan logique, génération par moteur |
| `packages/engine` | Adaptateurs PostgreSQL, MongoDB et SQL Server : connexion, introspection, exécution |
| `packages/cli` | CLI local : appairage, tunnel, exécution, migrations ORM |
| `packages/canvas` | Moteur du canvas : vue, nodes, arêtes, sélection, redimensionnement |
| `packages/design-system` | Tokens, thème et composants |
| `packages/tunnel-protocol` | Protocole du tunnel chiffré |
| `packages/db` | Schéma et migrations de la base applicative |
| `infra` | Docker Compose de développement et de production |

## Licence

Logiciel propriétaire — © Anthonin COLAS, tous droits réservés. Voir [LICENSE](LICENSE).
