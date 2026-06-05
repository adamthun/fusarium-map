#!/usr/bin/env python3
"""
Fusarium monitoring — Historikus adatok visszatöltése
=====================================================
Open-Meteo ERA5 archive alapján 2024-2025 teljes
Fusarium szezon (április 1. – október 31.) adatai.

Forrás: archive-api.open-meteo.com (ingyenes, regisztráció nélkül)
ERA5 reanalysis: ECMWF, ~9km rács, validált historikus adat
"""

import os, sys, time, logging, argparse, requests
from datetime import datetime, timezone
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
OM_BASE      = "https://archive-api.open-meteo.com/v1/archive"

STATION_COORDS = {
    44309: (46.2561, 20.0900, "Szeged"),
    44206: (46.9167, 19.7500, "Kecskemét"),
    54201: (47.1667, 20.1833, "Szolnok"),
    54713: (46.5667, 20.6667, "Orosháza"),
    63510: (47.4900, 21.6153, "Debrecen"),
    64100: (47.9500, 21.7167, "Nyíregyháza"),
    64716: (47.1000, 20.7500, "Túrkeve"),
    43609: (46.1947, 18.9583, "Baja"),
    42409: (46.6167, 18.8567, "Paks"),
    35418: (47.3111, 18.7800, "Martonvásár"),
    35315: (47.1900, 18.5836, "Agárd"),
    36306: (46.9033, 18.0478, "Siófok"),
    27815: (46.3628, 17.8739, "Kaposvár"),
    37404: (46.0022, 18.2272, "Pécs"),
    37713: (45.9833, 18.6833, "Mohács"),
    29403: (45.8675, 17.8511, "Sellye"),
    36605: (46.3792, 18.1333, "Dombóvár"),
    23703: (47.7100, 17.6747, "Győr"),
    23201: (47.8897, 17.2672, "Mosonmagyaróvár"),
    15310: (47.1983, 16.6478, "Szombathely"),
    26505: (46.7356, 17.2386, "Keszthely"),
    34712: (47.4494, 18.5775, "Felcsút"),
    13704: (47.6783, 16.6022, "Sopron"),
    24607: (47.3706, 17.4964, "Pápa"),
    25820: (47.0828, 17.9706, "Szentkirályszabadja"),
    34233: (47.5889, 18.3853, "Tatabánya"),
    53509: (47.8983, 20.3753, "Eger"),
    53411: (48.1000, 20.7833, "Miskolc"),
    43113: (47.4314, 19.1822, "Budapest"),
    32805: (48.0269, 18.8256, "Tésa"),
}

# Fusarium szezon: április 1. – október 31.
import datetime as _dt
_today = _dt.date.today().isoformat()
SEASONS = {
    2024: ("2024-04-01", "2024-10-31"),
    2025: ("2025-04-01", "2025-10-31"),
    2026: ("2026-04-01", _today),  # folyamatosan bővül
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ"
)
log = logging.getLogger("fusarium-backfill")


def fetch_season(station_id, lat, lon, name, start, end):
    """Open-Meteo ERA5 szezon letöltése."""
    try:
        r = requests.get(OM_BASE, params={
            "latitude":   lat,
            "longitude":  lon,
            "start_date": start,
            "end_date":   end,
            "hourly": "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m",
            "timezone": "UTC",
            "wind_speed_unit": "ms",
        }, timeout=60)
        r.raise_for_status()
        d = r.json()
    except Exception as e:
        log.error(f"  [{name}] HTTP hiba: {e}")
        return []

    h = d.get("hourly", {})
    times = h.get("time", [])
    temps = h.get("temperature_2m", [])
    rhs   = h.get("relative_humidity_2m", [])
    precs = h.get("precipitation", [])
    winds = h.get("wind_speed_10m", [])

    rows = []
    for i, t in enumerate(times):
        try:
            obs_time = datetime.fromisoformat(t).replace(tzinfo=timezone.utc)
            temp = float(temps[i]) if i < len(temps) and temps[i] is not None else None
            rh   = float(rhs[i])   if i < len(rhs)   and rhs[i]   is not None else None
            if temp is None and rh is None:
                continue
            rows.append({
                "station_id": station_id,
                "obs_time":   obs_time.isoformat(),
                "temp":       round(temp, 2) if temp is not None else None,
                "rh":         round(rh, 2)   if rh   is not None else None,
                "precip":     round(float(precs[i]), 2) if i < len(precs) and precs[i] is not None else None,
                "wind_speed": round(float(winds[i]), 2) if i < len(winds) and winds[i] is not None else None,
                "source":     "OpenMeteo-ERA5",
            })
        except Exception:
            continue
    return rows


def upsert_rows(sb, rows, batch=500):
    total = 0
    for i in range(0, len(rows), batch):
        sb.table("hourly_obs").upsert(
            rows[i:i+batch], on_conflict="station_id,obs_time"
        ).execute()
        total += len(rows[i:i+batch])
    return total


def calc_season_risk(sb, year, start, end):
    """Kockázatszámítás a szezon összes napjára."""
    from datetime import date, timedelta
    start_d = date.fromisoformat(start)
    end_d   = date.fromisoformat(end)
    today   = date.today()

    # Ne számolj jövőbeli napokra
    end_d = min(end_d, today - timedelta(days=1))
    if start_d > end_d:
        return

    log.info(f"  Kockázatszámítás: {start_d} – {end_d}")
    result = sb.rpc("compute_daily_risk_range", {
        "p_start": start_d.isoformat(),
        "p_end":   end_d.isoformat()
    }).execute()
    n = len(result.data) if result.data else 0
    log.info(f"  → {n} állomás×nap kiszámítva")


def main():
    parser = argparse.ArgumentParser(description="Fusarium historikus backfill")
    parser.add_argument("--years", nargs="+", type=int, default=[2024, 2025, 2026],
                        help="Évek (pl. --years 2024 2025)")
    parser.add_argument("--no-calc", action="store_true", help="Kockázatszámítás kihagyása")
    args = parser.parse_args()

    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    total = 0

    for year in args.years:
        if year not in SEASONS:
            log.warning(f"Ismeretlen év: {year}")
            continue

        start, end = SEASONS[year]
        log.info(f"═══ {year} szezon: {start} – {end} ═══")

        for sid, (lat, lon, name) in STATION_COORDS.items():
            log.info(f"  [{sid}] {name}")
            rows = fetch_season(sid, lat, lon, name, start, end)
            if rows:
                n = upsert_rows(sb, rows)
                total += n
                log.info(f"    → {n} sor betöltve")
            else:
                log.warning(f"    → Nincs adat")
            time.sleep(0.15)  # API rate limit

        if not args.no_calc:
            calc_season_risk(sb, year, start, end)

    log.info(f"══ Összesen: {total} sor betöltve ══")


if __name__ == "__main__":
    main()
