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

# Le dump officiel est PascalCase (Artist.ArtistId) — les seeds PG/Mongo sont
# snake_case. La parité nominale est ce qui permet d'éprouver les MÊMES
# requêtes SNQL sur les 3 moteurs (chinook-parity ×3) : on renomme tout.
# Colonnes d'abord (les refs table.col utilisent le nom de table encore
# PascalCase), tables ensuite. Les noms de contraintes (PK_Artist…) restent.
echo "→ Renommage snake_case (parité nominale PG/Mongo)…"
TMP_RENAME="$(mktemp -t chinook-mssql-rename.XXXXXX.sql)"
cat > "${TMP_RENAME}" << 'EOSQL'
-- Renommage snake_case (parité nominale PG/Mongo — mêmes requêtes SNQL ×3)
EXEC sp_rename 'Album.AlbumId', 'album_id', 'COLUMN';
EXEC sp_rename 'Album.Title', 'title', 'COLUMN';
EXEC sp_rename 'Album.ArtistId', 'artist_id', 'COLUMN';
EXEC sp_rename 'Artist.ArtistId', 'artist_id', 'COLUMN';
EXEC sp_rename 'Artist.Name', 'name', 'COLUMN';
EXEC sp_rename 'Customer.CustomerId', 'customer_id', 'COLUMN';
EXEC sp_rename 'Customer.FirstName', 'first_name', 'COLUMN';
EXEC sp_rename 'Customer.LastName', 'last_name', 'COLUMN';
EXEC sp_rename 'Customer.Company', 'company', 'COLUMN';
EXEC sp_rename 'Customer.Address', 'address', 'COLUMN';
EXEC sp_rename 'Customer.City', 'city', 'COLUMN';
EXEC sp_rename 'Customer.State', 'state', 'COLUMN';
EXEC sp_rename 'Customer.Country', 'country', 'COLUMN';
EXEC sp_rename 'Customer.PostalCode', 'postal_code', 'COLUMN';
EXEC sp_rename 'Customer.Phone', 'phone', 'COLUMN';
EXEC sp_rename 'Customer.Fax', 'fax', 'COLUMN';
EXEC sp_rename 'Customer.Email', 'email', 'COLUMN';
EXEC sp_rename 'Customer.SupportRepId', 'support_rep_id', 'COLUMN';
EXEC sp_rename 'Employee.EmployeeId', 'employee_id', 'COLUMN';
EXEC sp_rename 'Employee.LastName', 'last_name', 'COLUMN';
EXEC sp_rename 'Employee.FirstName', 'first_name', 'COLUMN';
EXEC sp_rename 'Employee.Title', 'title', 'COLUMN';
EXEC sp_rename 'Employee.ReportsTo', 'reports_to', 'COLUMN';
EXEC sp_rename 'Employee.BirthDate', 'birth_date', 'COLUMN';
EXEC sp_rename 'Employee.HireDate', 'hire_date', 'COLUMN';
EXEC sp_rename 'Employee.Address', 'address', 'COLUMN';
EXEC sp_rename 'Employee.City', 'city', 'COLUMN';
EXEC sp_rename 'Employee.State', 'state', 'COLUMN';
EXEC sp_rename 'Employee.Country', 'country', 'COLUMN';
EXEC sp_rename 'Employee.PostalCode', 'postal_code', 'COLUMN';
EXEC sp_rename 'Employee.Phone', 'phone', 'COLUMN';
EXEC sp_rename 'Employee.Fax', 'fax', 'COLUMN';
EXEC sp_rename 'Employee.Email', 'email', 'COLUMN';
EXEC sp_rename 'Genre.GenreId', 'genre_id', 'COLUMN';
EXEC sp_rename 'Genre.Name', 'name', 'COLUMN';
EXEC sp_rename 'Invoice.InvoiceId', 'invoice_id', 'COLUMN';
EXEC sp_rename 'Invoice.CustomerId', 'customer_id', 'COLUMN';
EXEC sp_rename 'Invoice.InvoiceDate', 'invoice_date', 'COLUMN';
EXEC sp_rename 'Invoice.BillingAddress', 'billing_address', 'COLUMN';
EXEC sp_rename 'Invoice.BillingCity', 'billing_city', 'COLUMN';
EXEC sp_rename 'Invoice.BillingState', 'billing_state', 'COLUMN';
EXEC sp_rename 'Invoice.BillingCountry', 'billing_country', 'COLUMN';
EXEC sp_rename 'Invoice.BillingPostalCode', 'billing_postal_code', 'COLUMN';
EXEC sp_rename 'Invoice.Total', 'total', 'COLUMN';
EXEC sp_rename 'InvoiceLine.InvoiceLineId', 'invoice_line_id', 'COLUMN';
EXEC sp_rename 'InvoiceLine.InvoiceId', 'invoice_id', 'COLUMN';
EXEC sp_rename 'InvoiceLine.TrackId', 'track_id', 'COLUMN';
EXEC sp_rename 'InvoiceLine.UnitPrice', 'unit_price', 'COLUMN';
EXEC sp_rename 'InvoiceLine.Quantity', 'quantity', 'COLUMN';
EXEC sp_rename 'MediaType.MediaTypeId', 'media_type_id', 'COLUMN';
EXEC sp_rename 'MediaType.Name', 'name', 'COLUMN';
EXEC sp_rename 'Playlist.PlaylistId', 'playlist_id', 'COLUMN';
EXEC sp_rename 'Playlist.Name', 'name', 'COLUMN';
EXEC sp_rename 'PlaylistTrack.PlaylistId', 'playlist_id', 'COLUMN';
EXEC sp_rename 'PlaylistTrack.TrackId', 'track_id', 'COLUMN';
EXEC sp_rename 'Track.TrackId', 'track_id', 'COLUMN';
EXEC sp_rename 'Track.Name', 'name', 'COLUMN';
EXEC sp_rename 'Track.AlbumId', 'album_id', 'COLUMN';
EXEC sp_rename 'Track.MediaTypeId', 'media_type_id', 'COLUMN';
EXEC sp_rename 'Track.GenreId', 'genre_id', 'COLUMN';
EXEC sp_rename 'Track.Composer', 'composer', 'COLUMN';
EXEC sp_rename 'Track.Milliseconds', 'milliseconds', 'COLUMN';
EXEC sp_rename 'Track.Bytes', 'bytes', 'COLUMN';
EXEC sp_rename 'Track.UnitPrice', 'unit_price', 'COLUMN';
EXEC sp_rename 'Album', 'album';
EXEC sp_rename 'Artist', 'artist';
EXEC sp_rename 'Customer', 'customer';
EXEC sp_rename 'Employee', 'employee';
EXEC sp_rename 'Genre', 'genre';
EXEC sp_rename 'Invoice', 'invoice';
EXEC sp_rename 'InvoiceLine', 'invoice_line';
EXEC sp_rename 'MediaType', 'media_type';
EXEC sp_rename 'Playlist', 'playlist';
EXEC sp_rename 'PlaylistTrack', 'playlist_track';
EXEC sp_rename 'Track', 'track';
EOSQL
docker cp "${TMP_RENAME}" "${CONTAINER}:/tmp/chinook-rename.sql"
docker exec -u root "${CONTAINER}" chmod 644 /tmp/chinook-rename.sql
run_sql -b -d "${DB}" -i /tmp/chinook-rename.sql -o /dev/null
docker exec -u root "${CONTAINER}" rm -f /tmp/chinook-rename.sql
rm -f "${TMP_RENAME}"

TABLES=$(run_sql -d "${DB}" -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'" -h -1 | tr -d '[:space:]')
echo "✓ Chinook chargée : ${TABLES} tables."
echo "  DSN : mssql://sa:${SA_PASSWORD}@localhost:1433/${DB}?trustServerCertificate=true"
