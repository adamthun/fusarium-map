#!/usr/bin/env python3
"""
Fusarium monitoring — HungaroMet ODP adatletöltő
================================================
Letölti az OMSZ szinoptikus óránkénti CSV fájlokat és
feltölti a Supabase adatbázisba.

Hivatkozás:
  Mesterházy Á. et al. (1999) Plant Breeding 118:97-110
  Gyimes E. et al. (2012) Növényvédelem 48(8):347-352

Adatforrás:
  https://odp.met.hu/weather/weather_reports/synoptic/hungary/hourly/
"""

import os
import sys
import io
import csv
import zipfile
import logging
import argparse
import requests
from datetime import datetime, timedelta, timezone
from supabase import create_client, Client

# ── Konfiguráció ────────────────────────────────────────────
ODP_BASE  = "https://odp.met.hu/weather/weather_reports/synoptic/hungary/hourly/csv"
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]  # service_role kulcs!

# Aktív állomások (station_id lista) — szinkronban a DB-vel
STATION_IDS = {
    44309, 44206, 54201, 54713, 63510, 64100, 64716, 43609, 42409,  # Alföld
    35418, 35315, 36306, 27815, 37404, 37713, 29403, 36605,          # Dunántúl
    23703, 23201, 15310, 26505, 34712, 13704, 24607, 25820, 34233,   # Dunántúl
    53509, 53411, 43113, 32805,                                       # Észak
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ"
)
log = logging.getLogger("fusarium-fetcher")


def build_url(date: datetime) -> str:
    """ODP CSV ZIP URL összeállítása adott napra."""
    fname = f"HABP_1H_{date.strftime('%Y%m%d')}.csv.zip"
    return f"{ODP_BASE}/{fname}"


def download_csv(date: datetime) -> list[dict]:
    """CSV letöltése és sorok visszaadása listában."""
    url = build_url(date)
    log.info(f"Letöltés: {url}")

    r = requests.get(url, timeout=60)
    if r.status_code == 404:
        log.warning(f"Nem található: {url}")
        return []
    r.raise_for_status()

    # ZIP kicsomagolása
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        csv_name = [n for n in zf.namelist() if n.endswith(".csv")][0]
        raw = zf.read(csv_name).decode("utf-8", errors="replace")

    return parse_csv(raw)


def parse_csv(raw: str) -> list[dict]:
    """
    ODP CSV formátum feldolgozása.
    A fájl ## kommentsorokkal kezdődik, majd fejlécsor jön.
    Adathiány jele: -999
    Főbb oszlopok: StationNumber, Time, ta (hőm.), u (RH), r (csap.), fs (szél)
    """
    lines = raw.splitlines()

    # Fejlécsor megkeresése (## nélküli első sor)
    header_idx = next((i for i, l in enumerate(lines) if not l.startswith("#")), None)
    if header_idx is None:
        log.error("Nem található fejlécsor a CSV-ben")
        return []

    reader = csv.DictReader(lines[header_idx:], delimiter=";")
    rows = []

    for row in reader:
        try:
            sid = int(row.get("StationNumber", row.get("station_number", 0)))
            if sid not in STATION_IDS:
                continue

            # Időbélyeg: YYYYMMDDHHmm UTC
            t_raw = row.get("Time", row.get("time", "")).strip()
            if len(t_raw) < 10:
                continue
            obs_time = datetime.strptime(t_raw[:12].ljust(12, "0"), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)

            def safe(col, scale=1.0):
                """Szám kinyerése, -999 → None."""
                v = row.get(col, "").strip()
                if not v or v in ("-999", ""):
                    return None
                try:
                    f = float(v) * scale
                    return round(f, 2)
                except ValueError:
                    return None

            rows.append({
                "station_id":  sid,
                "obs_time":    obs_time.isoformat(),
                "temp":        safe("ta"),
                "rh":          safe("u"),
                "precip":      safe("r"),
                "wind_speed":  safe("fs"),
                "pressure":    safe("p"),
                "global_rad":  safe("sr"),
            })
        except Exception as e:
            log.debug(f"Sor kihagyva: {e}")
            continue

    log.info(f"  → {len(rows)} sor feldolgozva")
    return rows


def upsert_to_supabase(sb: Client, rows: list[dict]) -> int:
    """Sorok upsert a Supabase hourly_obs táblába, kötegelt (batch 500)."""
    if not rows:
        return 0

    inserted = 0
    batch_size = 500
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i+batch_size]
        resp = sb.table("hourly_obs").upsert(batch, on_conflict="station_id,obs_time").execute()
        inserted += len(batch)
        log.info(f"  Upsert batch {i//batch_size+1}: {len(batch)} sor")

    return inserted


def trigger_risk_calculation(sb: Client, date_str: str):
    """Fusarium kockázatszámítás triggerelése SQL függvényen keresztül."""
    log.info(f"Kockázatszámítás: {date_str}")
    try:
        result = sb.rpc("compute_daily_risk", {"p_date": date_str}).execute()
        n = len(result.data) if result.data else 0
        log.info(f"  → {n} állomás kockázata kiszámítva")
    except Exception as e:
        log.error(f"Kockázatszámítás hiba: {e}")


def main():
    parser = argparse.ArgumentParser(description="Fusarium ODP adatletöltő")
    parser.add_argument("--date", help="Dátum YYYY-MM-DD (alapért: tegnap)")
    parser.add_argument("--days", type=int, default=1, help="Hány napra visszamenőleg (max 7)")
    parser.add_argument("--no-calc", action="store_true", help="Ne futtasson kockázatszámítást")
    args = parser.parse_args()

    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # Dátumok meghatározása
    if args.date:
        end_date = datetime.strptime(args.date, "%Y-%m-%d")
    else:
        end_date = datetime.utcnow() - timedelta(days=1)

    dates = [end_date - timedelta(days=i) for i in range(min(args.days, 7)-1, -1, -1)]

    total = 0
    for d in dates:
        try:
            rows = download_csv(d)
            inserted = upsert_to_supabase(sb, rows)
            total += inserted
            log.info(f"✓ {d.strftime('%Y-%m-%d')}: {inserted} sor betöltve")
        except Exception as e:
            log.error(f"✗ {d.strftime('%Y-%m-%d')}: {e}")

    log.info(f"Összesen: {total} sor betöltve")

    if not args.no_calc:
        for d in dates:
            trigger_risk_calculation(sb, d.strftime("%Y-%m-%d"))


if __name__ == "__main__":
    main()
