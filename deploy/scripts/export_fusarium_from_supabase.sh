#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Fusarium adatok exportja a Supabase-ből — KIZÁRÓLAG a 3 fuzárium tábla
#   public.stations, public.hourly_obs, public.fusarium_risk
#
# A Supabase projektet más alkalmazások is használják, ezért NEM teljes
# dump: csak ezeknek a tábláknak az ADATAI kerülnek ki (séma nélkül —
# a sémát a db/init/01_schema.sql hozza létre az új szerveren).
# Olvasási művelet, a Supabase-ben semmit nem módosít.
#
# Használat (bármely gépen, ahol van Docker):
#   SUPABASE_DB_URL='postgresql://postgres.<ref>:<jelszo>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres' \
#     ./scripts/export_fusarium_from_supabase.sh
# Eredmény: backups/fusarium_export_YYYYMMDD.sql.gz
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SUPABASE_DB_URL:?Add meg a SUPABASE_DB_URL-t (Session pooler connection string)}"

TABLES=(public.stations public.hourly_obs public.fusarium_risk)
OUT="backups/fusarium_export_$(date +%Y%m%d).sql.gz"
mkdir -p backups

ARGS=(--data-only --no-owner --no-privileges --column-inserts --rows-per-insert=1000)
for t in "${TABLES[@]}"; do ARGS+=(--table="$t"); done

echo "Exportálás (csak: ${TABLES[*]}) → $OUT"
docker run --rm -e PGCONNECT_TIMEOUT=20 postgres:17 \
  pg_dump "$SUPABASE_DB_URL" "${ARGS[@]}" | gzip > "$OUT"

# Ellenőrzés: más tábla nem került bele
OTHER=$(zcat "$OUT" | grep -oE '^INSERT INTO [a-z_."]+' | sort -u | grep -vE 'public\.(stations|hourly_obs|fusarium_risk)' || true)
if [ -n "$OTHER" ]; then echo "HIBA: váratlan tábla az exportban: $OTHER"; rm -f "$OUT"; exit 1; fi

echo "Kész. Sorok táblánként (INSERT utasítások × max 1000 sor):"
zcat "$OUT" | grep -oE '^INSERT INTO public\.[a-z_]+' | sort | uniq -c
ls -lh "$OUT"
