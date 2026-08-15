#!/usr/bin/env bash
# Charge la DB de démo Chinook (musique) dans le container `sqlnest-postgres`
# — 11 tables, ~15k rows, relations riches (Artist-Album-Track,
# Customer-Invoice-InvoiceLine, Employee hiérarchique). Portable PG 12-17.
#
# Pourquoi Chinook au lieu de Pagila ? Pagila (fork moderne) utilise des
# features PG 17-18 (VIRTUAL columns, pgvector, uuidv7) qui cassent sur
# postgres:16-alpine. Chinook est un seul fichier SQL testé partout.
#
# Usage :
#   pnpm db:seed:chinook          → crée la DB `chinook` et charge tout
#   pnpm db:seed:chinook --reset  → drop puis recharge
#
# Accès : postgres://sqlnest:sqlnest@localhost:5433/chinook

set -euo pipefail

CONTAINER="sqlnest-postgres"
DB="chinook"
USER="sqlnest"
# Version historique (Chinook_PostgreSql.sql) — portable PG 12+. La variante
# SerialPKs récente est dumpée depuis PG 18 et utilise `\restrict` / SET
# transaction_timeout, incompatible PG < 17.
SCHEMA_URL="https://raw.githubusercontent.com/lerocha/chinook-database/master/ChinookDatabase/DataSources/Chinook_PostgreSql.sql"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "✗ Container « ${CONTAINER} » pas démarré. Lance : pnpm db:up"
    exit 1
fi

# Le dump Chinook fait son propre `DROP DATABASE IF EXISTS chinook` +
# `CREATE DATABASE chinook` — on n'a rien à créer/dropper manuellement.
# Le flag `--reset` est donc no-op (kept pour parité UX avec les autres
# seed scripts).
if [[ "${1:-}" == "--reset" ]]; then
    echo "→ --reset : le dump Chinook fait DROP+CREATE en interne, rien de plus à faire."
fi

TMP=$(mktemp -d)
trap "rm -rf ${TMP}" EXIT

echo "→ Téléchargement du dump Chinook (~2 MB)…"
curl -fsSL "${SCHEMA_URL}" -o "${TMP}/chinook.sql"

# Le dump fait son propre DROP DATABASE + CREATE DATABASE + \c chinook
# → on l'exécute directement depuis la DB `postgres` (la seule toujours
# dispo pour un DROP DATABASE). Notre check `already exists` plus haut
# a été skippé si le drop implicite est OK, mais on log l'action.
echo "→ Chargement du dump (DROP + CREATE + data)…"
docker exec -i "${CONTAINER}" psql -U "${USER}" -d postgres -q \
    < "${TMP}/chinook.sql" > /dev/null

COUNT=$(docker exec -i "${CONTAINER}" psql -U "${USER}" -d "${DB}" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")
echo "✓ ${DB} chargée — ${COUNT} tables"

echo ""
echo "  DSN : postgres://sqlnest:sqlnest@localhost:5433/${DB}"
echo "  Ajoute-la au CLI :"
echo "    sqlnest-dev add-connection --name chinook --url \"postgres://sqlnest:sqlnest@localhost:5433/${DB}\""
