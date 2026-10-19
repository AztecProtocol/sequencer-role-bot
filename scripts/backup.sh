#!/bin/sh
# Write one compressed dump of the bot database to a local directory and
# delete the oldest dumps.
#
#   DATABASE_URL  connection string of the database to dump (required)
#   BACKUP_DIR    directory for the dump files (default: /backups)
#   BACKUP_KEEP   number of dump files to keep (default: 14)
#
# Restore: gunzip -c <file> | psql "$DATABASE_URL"
set -eu

: "${DATABASE_URL:?DATABASE_URL is not set}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"

# The dump contains Discord account ids and wallet addresses.
umask 077
mkdir -p "$BACKUP_DIR"
cd "$BACKUP_DIR"

name="aztec-bot-backup-$(date -u +%Y-%m-%dT%H-%M-%SZ).sql.gz"
tmp=".$name.tmp"

# Write to a temporary name, so a failed dump never looks like a backup.
if ! pg_dump --dbname="$DATABASE_URL" --no-owner --compress=9 --file="$tmp"; then
  rm -f "$tmp"
  echo "Backup failed. No older backup was deleted." >&2
  exit 1
fi
mv "$tmp" "$name"
echo "Backup written: $BACKUP_DIR/$name"

# The names sort by time. Delete all but the newest BACKUP_KEEP files.
total=$(ls -1 aztec-bot-backup-*.sql.gz | wc -l)
excess=$((total - BACKUP_KEEP))
if [ "$excess" -gt 0 ]; then
  ls -1 aztec-bot-backup-*.sql.gz | sort | head -n "$excess" | while read -r old; do
    rm -f "$old"
    echo "Old backup deleted: $old"
  done
fi
