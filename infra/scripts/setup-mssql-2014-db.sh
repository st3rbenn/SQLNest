#!/usr/bin/env bash
# Monte une base « mode 2014 » sur le conteneur `sqlnest-mssql` à partir d'un
# fichier SQL fourni (dump utilisateur) : crée la DB avec
# COMPATIBILITY_LEVEL = 120 (comportement moteur SQL Server 2014) puis
# exécute le fichier dedans (batches GO supportés par sqlcmd).
#
# ⚠ Le compat level reproduit le comportement du QUERY PROCESSOR 2014
# (OPENJSON indisponible, etc.) mais PAS l'absence des builtins liés à la
# VERSION du serveur (FOR JSON, STRING_AGG… existent toujours sur le binaire
# 2022) — la validation finale reste la vraie instance 2014 (M/7).
#
# Usage :
#   infra/scripts/setup-mssql-2014-db.sh <fichier.sql> [nom_db]
#   infra/scripts/setup-mssql-2014-db.sh <fichier.sql> [nom_db] --reset
#
# Si le fichier contient son propre CREATE DATABASE + USE, passe "-" comme
# nom_db : le script exécute le fichier tel quel et ne crée rien (le compat
# level est alors à régler à la main sur la DB créée par le dump).

set -euo pipefail

CONTAINER="sqlnest-mssql"
SA_PASSWORD="SqlNest!Dev2022"
SQLCMD="/opt/mssql-tools18/bin/sqlcmd"

SQL_FILE="${1:?Usage: setup-mssql-2014-db.sh <fichier.sql> [nom_db] [--reset]}"
DB="${2:-legacy2014}"
RESET="${3:-}"

if [[ ! -f "${SQL_FILE}" ]]; then
    echo "✗ Fichier introuvable : ${SQL_FILE}"
    exit 1
fi
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "✗ Container « ${CONTAINER} » pas démarré. Lance : pnpm db:up"
    exit 1
fi

run_sql() {
    docker exec "${CONTAINER}" ${SQLCMD} -S localhost -U sa -P "${SA_PASSWORD}" -C -b "$@"
}

if [[ "${DB}" != "-" ]]; then
    if [[ "${RESET}" == "--reset" ]]; then
        echo "→ Drop ${DB} (si présente)…"
        run_sql -Q "IF DB_ID('${DB}') IS NOT NULL BEGIN ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}]; END"
    elif run_sql -Q "SELECT DB_ID('${DB}')" -h -1 2>/dev/null | grep -qE '^[[:space:]]*[0-9]+'; then
        echo "✓ DB « ${DB} » déjà présente — rien à faire (utilise --reset pour recharger)."
        exit 0
    fi
    echo "→ CREATE DATABASE ${DB} + COMPATIBILITY_LEVEL = 120…"
    run_sql -Q "CREATE DATABASE [${DB}]; ALTER DATABASE [${DB}] SET COMPATIBILITY_LEVEL = 120"
fi

echo "→ Copie du fichier + exécution sqlcmd (batches GO)…"
docker cp "${SQL_FILE}" "${CONTAINER}:/tmp/user-2014.sql"
# docker cp laisse le fichier owné root ; l'image tourne en user mssql.
docker exec -u root "${CONTAINER}" chmod 644 /tmp/user-2014.sql
if [[ "${DB}" != "-" ]]; then
    run_sql -I -d "${DB}" -i /tmp/user-2014.sql
else
    run_sql -I -i /tmp/user-2014.sql
fi
docker exec -u root "${CONTAINER}" rm -f /tmp/user-2014.sql

if [[ "${DB}" != "-" ]]; then
    TABLES=$(run_sql -d "${DB}" -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'" -h -1 | tr -d '[:space:]')
    COMPAT=$(run_sql -Q "SET NOCOUNT ON; SELECT compatibility_level FROM sys.databases WHERE name = '${DB}'" -h -1 | tr -d '[:space:]')
    echo "✓ DB « ${DB} » chargée : ${TABLES} tables, compatibility_level ${COMPAT}."
    echo "  DSN : mssql://sa:${SA_PASSWORD}@localhost:1433/${DB}?trustServerCertificate=true"
fi
