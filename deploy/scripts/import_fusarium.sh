#!/usr/bin/env bash
# Az export betöltése az új szerver adatbázisába (docker compose stack fut).
# A 3 fuzárium táblát kiüríti, majd betölti az exportot.
# Használat: ./scripts/import_fusarium.sh backups/fusarium_export_YYYYMMDD.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?Add meg az export fájlt}"
set -a; . ./.env; set +a
PSQL=(docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-fusarium}" -d "${POSTGRES_DB:-fusarium}")

echo "A worker leállítása az import idejére…"
docker compose stop worker

echo "Táblák ürítése és betöltés: $FILE"
{
  echo "BEGIN;"
  echo "TRUNCATE fusarium_risk, hourly_obs, stations CASCADE;"
  zcat -f "$FILE" | grep -vE '^(SET transaction_timeout|SELECT pg_catalog.set_config)'
  echo "COMMIT;"
  echo "ANALYZE stations; ANALYZE hourly_obs; ANALYZE fusarium_risk;"
} | "${PSQL[@]}" -q

"${PSQL[@]}" -c "SELECT (SELECT count(*) FROM stations) AS allomas, (SELECT count(*) FROM hourly_obs) AS meres, (SELECT count(*) FROM fusarium_risk) AS kockazat, (SELECT max(calc_date) FROM fusarium_risk) AS utolso_nap;"

echo "Worker újraindítása (pótolja a hiányzó napokat)…"
docker compose start worker
