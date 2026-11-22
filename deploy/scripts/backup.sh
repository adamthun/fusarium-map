#!/usr/bin/env bash
# Napi mentés (cron-ból): 0 3 * * * /opt/fusarium-map/deploy/scripts/backup.sh >> /var/log/fusarium-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
KEEP_DAYS="${KEEP_DAYS:-14}"
F="backups/fusarium_$(date +%Y%m%d_%H%M).dump"
docker compose exec -T db pg_dump -U "${POSTGRES_USER:-fusarium}" -d "${POSTGRES_DB:-fusarium}" -Fc > "$F"
find backups -name 'fusarium_*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) mentés kész: $F ($(du -h "$F" | cut -f1))"
