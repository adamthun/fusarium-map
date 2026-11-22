#!/usr/bin/env bash
# Visszaállítás a backup.sh által készített mentésből (FELÜLÍRJA az adatbázist!)
# Használat: ./scripts/restore.sh backups/fusarium_YYYYMMDD_HHMM.dump
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?Add meg a .dump fájlt}"
set -a; . ./.env; set +a
read -r -p "Biztosan felülírod az adatbázist a(z) $FILE mentéssel? (igen/nem) " a
[ "$a" = "igen" ] || exit 1
docker compose stop worker api
docker compose exec -T db pg_restore -U "${POSTGRES_USER:-fusarium}" -d "${POSTGRES_DB:-fusarium}" --clean --if-exists --no-owner < "$FILE"
docker compose start api worker
echo "Visszaállítás kész."
