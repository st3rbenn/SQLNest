#!/usr/bin/env bash
# SQLNest — backup Postgres quotidien
# Cron entry (crontab -e) :
#   0 3 * * * /opt/sqlnest/infra/scripts/backup-db.sh >> /var/log/sqlnest/backup.log 2>&1
#
# Rotation : garde 14 jours de backups (~14 fichiers gz).

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/sqlnest}"
CONTAINER="${CONTAINER:-sqlnest-postgres-1}"
DB_USER="${DB_USER:-sqlnest}"
DB_NAME="${DB_NAME:-sqlnest}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="$BACKUP_DIR/sqlnest-${TIMESTAMP}.sql.gz"

echo "[backup-db] $(date -Iseconds) → $DUMP_FILE"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --format=plain \
    | gzip -9 > "$DUMP_FILE"

echo "[backup-db] taille : $(du -h "$DUMP_FILE" | cut -f1)"

# Rotation — supprime les backups plus vieux que RETENTION_DAYS jours.
DELETED="$(find "$BACKUP_DIR" -name 'sqlnest-*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete -print | wc -l | tr -d ' ')"
echo "[backup-db] rotation : $DELETED anciens backups supprimés"

echo "[backup-db] OK"
