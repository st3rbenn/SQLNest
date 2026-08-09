# `@sqlnest/cli`

CLI locale SQLNest — pairing device flow + tunnel WSS entre ta machine et ton compte [dev.sqlnest.io](https://dev.sqlnest.io). Tes credentials Postgres ne quittent jamais ton laptop.

## Install

```bash
npx @sqlnest/cli connect
```

Ou installation globale :

```bash
npm i -g @sqlnest/cli
sqlnest --help
```

Requiert **Node.js ≥ 22**.

## Usage

### Premier pairing

```bash
sqlnest connect
```

Ouvre `https://dev.sqlnest.io/pair`, affiche un code à saisir dans l'UI. Une fois approuvé, la CLI ouvre un WSS et sert les requêtes de ton canvas contre ta DB locale.

### Ajouter une DSN locale

```bash
sqlnest add-connection --name prod
# prompts interactifs pour host / port / user / password (sans echo)
```

Les DSN sont stockées dans `~/.sqlnest/local-connections.toml` (perms `0600` obligatoires).

### Ping / diagnostic

```bash
sqlnest ping --tunnel prod
```

### CI (Bearer token)

```bash
sqlnest connect --token sn_xxxxx --name ci-worker-1
```

### Autres commandes

```bash
sqlnest logout --all              # retire tous les tunnels
sqlnest logout --tunnel <id>      # retire un tunnel
sqlnest revoke-connection --name prod
sqlnest --version
sqlnest --help
```

## Fichiers de config

Tout vit sous `~/.sqlnest/` (créé au premier `connect`, perms `0700`) :

| Fichier | Rôle | Perms |
|---|---|---|
| `config.toml` | Keypair Ed25519 + liste des tunnels | `0600` |
| `local-connections.toml` | DSN Postgres locales | `0600` |

La CLI refuse de démarrer si les perms de ces fichiers sont trop ouvertes.

Override du répertoire (utile en test) :

```bash
SQLNEST_CONFIG_DIR=/tmp/sqlnest-test sqlnest connect
```

## Exit codes

- `0` — succès
- `1` — erreur runtime (backend down, timeout, sig invalide…)
- `2` — usage invalide (args manquants / inconnus)

## Sécurité

- Les DSN Postgres restent **exclusivement locales** — jamais transmises au backend SQLNest.
- Le backend SQLNest signe chaque requête avec une clé Ed25519 dérivée d'`AUTH_SECRET`. La CLI vérifie la signature avant d'exécuter — le tunnel WSS ne peut être détourné par un man-in-the-middle du serveur.
- La clé privée locale est chiffrée AES-256-GCM avec un salt tiré à l'install.

## Contributing

Le paquet publié pointe **en dur** sur `https://dev.sqlnest.io` — les URLs sont bakées à la compile via esbuild `--define:process.env.NODE_ENV="production"` + `--minify-syntax`. Aucune env var ne peut les override runtime — les strings `localhost` ne sont même pas présentes dans le binaire publié.

Pour dev local depuis les sources (jamais depuis le binaire publié) :

```bash
NODE_ENV=development pnpm --filter @sqlnest/cli exec tsx src/bin.ts connect
```

En dev-from-source, `tsx` évalue `process.env.NODE_ENV === "development"` à `true` → les URLs deviennent `http://localhost:4000` / `http://localhost:3000`. Rien de baké, c'est le code source qui branche.

## License

ISC — © Anthonin COLAS
