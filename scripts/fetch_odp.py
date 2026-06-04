#!/usr/bin/env python3
"""
Fusarium monitoring — HungaroMet ODP adatletöltő v2
Mesterházy Á. et al. (1999) Plant Breeding 118:97-110
Gyimes E. et al. (2012) Növényvédelem 48(8):347-352

Adatforrás: HungaroMet ODP
  Szinoptikus napi: odp.met.hu/weather/weather_reports/synoptic/hungary/daily/csv/
  Éghajlati óránkénti (hist): odp.met.hu/climate/observations_hungary/hourly/recent/
"""

import os, sys, io, csv, zipfile, logging, argparse, requests
from datetime import datetime, timedelta, timezone
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

# Óránkénti recent adatok URL-je
ODP_HOURLY_RECENT = "https://odp.met.hu/climate/observations_hungary/hourly/recent"

# Napi szinoptikus adatok URL-je (backup)
ODP_DAILY = "https://odp.met.hu/weather/weather_reports/synoptic/hungary/daily/csv"

STATION_IDS = {
    44309,44206,54201,54713,63510,64100,64716,43609,42409,
    35418,35315,36306,27815,37404,37713,29403,36605,
    23703,23201,15310,26505,34712,13704,24607,25820,34233,
    53509,53411,43113,32805,
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fusarium-fetcher")


def try_hourly_recent(station_id):
    """
    Óránkénti recent adat letöltése egy állomásra.
    URL: /climate/observations_hungary/hourly/recent/HABP_1H_{station_id}_recent.csv.zip
    """
    url = f"{ODP_HOURLY_RECENT}/HABP_1H_{station_id}_recent.csv.zip"
    try:
        r = requests.get(url, timeout=30)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.content
    except Exception as e:
        log.debug(f"Állomás {station_id} recent letöltési hiba: {e}")
        return None


def parse_csv_content(raw_bytes, station_id):
    """CSV feldolgozás: ## kommentsorok átugrása, adathiány -999 kezelés."""
    try:
        raw = raw_bytes.decode("utf-8", errors="replace")
    except Exception:
        raw = raw_bytes.decode("latin-1", errors="replace")

    lines = raw.splitlines()

    # Fejlécsor megkeresése
    header_idx = None
    for i, line in enumerate(lines):
        if not line.startswith("#") and line.strip():
            header_idx = i
            break

    if header_idx is None:
        return []

    reader = csv.DictReader(lines[header_idx:], delimiter=";")
    rows = []

    for row in reader:
        try:
            # Időbélyeg: YYYYMMDDHHmm
            t_raw = ""
            for key in ["Time", "time", "DATE", "date", "Időpont"]:
                if key in row and row[key].strip():
                    t_raw = row[key].strip()
                    break

            if len(t_raw) < 8:
                continue

            # Formátum próbálgatás
            t_raw_clean = t_raw[:12].ljust(12, "0")
            try:
                obs_time = datetime.strptime(t_raw_clean, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
            except ValueError:
                continue

            def safe(cols):
                for col in cols:
                    v = row.get(col, "").strip()
                    if v and v not in ("-999", "-999.0", ""):
                        try:
                            return round(float(v), 2)
                        except ValueError:
                            pass
                return None

            temp = safe(["ta", "Ta", "T", "temperature", "hőmérséklet"])
            rh   = safe(["u",  "U",  "RH", "humidity", "páratartalom"])

            if temp is None and rh is None:
                continue

            rows.append({
                "station_id": station_id,
                "obs_time":   obs_time.isoformat(),
                "temp":       temp,
                "rh":         rh,
                "precip":     safe(["r", "R", "precipitation"]),
                "wind_speed": safe(["fs", "Fs", "wind_speed"]),
            })
        except Exception as e:
            log.debug(f"Sor hiba: {e}")
            continue

    return rows


def unzip_and_parse(content, station_id):
    """ZIP kicsomagolása és CSV feldolgozása."""
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            csv_files = [n for n in zf.namelist() if n.endswith(".csv")]
            if not csv_files:
                return []
            raw = zf.read(csv_files[0])
            return parse_csv_content(raw, station_id)
    except Exception as e:
        log.warning(f"ZIP hiba állomás {station_id}: {e}")
        return []


def upsert_rows(sb, rows, batch_size=500):
    """Adatok feltöltése Supabase-be kötegesen."""
    total = 0
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i+batch_size]
        sb.table("hourly_obs").upsert(
            batch, on_conflict="station_id,obs_time"
        ).execute()
        total += len(batch)
    return total


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=1)
    parser.add_argument("--no-calc", action="store_true")
    args = parser.parse_args()

    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    total_inserted = 0

    for sid in STATION_IDS:
        log.info(f"Állomás {sid} letöltése...")
        content = try_hourly_recent(sid)

        if not content:
            log.warning(f"  → Állomás {sid}: nincs adat")
            continue

        rows = unzip_and_parse(content, sid)

        if not rows:
            log.warning(f"  → Állomás {sid}: 0 feldolgozható sor")
            continue

        # Csak a kért napok adatait töltjük be
        cutoff = datetime.now(timezone.utc) - timedelta(days=args.days + 1)
        rows = [r for r in rows if r["obs_time"] >= cutoff.isoformat()]

        inserted = upsert_rows(sb, rows)
        total_inserted += inserted
        log.info(f"  → {inserted} sor betöltve")

    log.info(f"Összesen: {total_inserted} sor")


if __name__ == "__main__":
    main()
