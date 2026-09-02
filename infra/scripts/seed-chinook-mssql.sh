#!/usr/bin/env bash
# Charge la DB de démo Chinook dans le container `sqlnest-mssql` — mêmes
# 11 tables/relations que chinook PG et chinook-mongo, pour éprouver les
# MÊMES requêtes SNQL sur les 3 moteurs (parité cross-engine, chantier M).
#
# La variante officielle SQL Server du repo lerocha crée la DB `Chinook`
# elle-même (CREATE DATABASE + USE + batches GO) — on la passe telle
# quelle à sqlcmd. `-C` : trust le self-signed généré par l'image au boot.
#
# Usage :
#   pnpm db:seed:chinook:mssql          → charge (échoue si DB déjà là)
#   pnpm db:seed:chinook:mssql --reset  → drop puis recharge
#
# Accès : mssql://sa:SqlNest!Dev2022@localhost:1433/Chinook?trustServerCertificate=true

set -euo pipefail

CONTAINER="sqlnest-mssql"
DB="Chinook"
SA_PASSWORD="SqlNest!Dev2022"
SQLCMD="/opt/mssql-tools18/bin/sqlcmd"
SCHEMA_URL="https://raw.githubusercontent.com/lerocha/chinook-database/master/ChinookDatabase/DataSources/Chinook_SqlServer.sql"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "✗ Container « ${CONTAINER} » pas démarré. Lance : pnpm db:up"
    exit 1
fi

run_sql() {
    docker exec "${CONTAINER}" ${SQLCMD} -S localhost -U sa -P "${SA_PASSWORD}" -C -b "$@"
}

if [[ "${1:-}" == "--reset" ]]; then
    echo "→ Drop ${DB} (si présente)…"
    run_sql -Q "IF DB_ID('${DB}') IS NOT NULL BEGIN ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}]; END"
elif run_sql -Q "SELECT DB_ID('${DB}')" -h -1 2>/dev/null | grep -qE '^[[:space:]]*[0-9]+'; then
    echo "✓ DB « ${DB} » déjà présente — rien à faire (utilise --reset pour recharger)."
    exit 0
fi

TMP_SQL="$(mktemp -t chinook-mssql.XXXXXX.sql)"
trap 'rm -f "${TMP_SQL}"' EXIT

echo "→ Téléchargement du schéma Chinook SQL Server…"
curl -fsSL "${SCHEMA_URL}" -o "${TMP_SQL}"

echo "→ Copie dans le container + exécution sqlcmd (batches GO)…"
docker cp "${TMP_SQL}" "${CONTAINER}:/tmp/chinook.sql"
# `docker cp` laisse le fichier owné root ; l'image 2022 tourne en user
# `mssql` → sqlcmd prend un access denied (0x80070005) sans chmod.
docker exec -u root "${CONTAINER}" chmod 644 /tmp/chinook.sql
# -I : QUOTED_IDENTIFIER ON (le dump utilise des identifiants quotés).
run_sql -I -i /tmp/chinook.sql -o /dev/null
docker exec -u root "${CONTAINER}" rm -f /tmp/chinook.sql

TABLES=$(run_sql -d "${DB}" -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'" -h -1 | tr -d '[:space:]')
echo "✓ Chinook chargée : ${TABLES} tables."
echo "  DSN : mssql://sa:${SA_PASSWORD}@localhost:1433/${DB}?trustServerCertificate=true"
