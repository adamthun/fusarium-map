#!/usr/bin/env python3
"""
Fusarium monitoring — Kettős adatforrás letöltő
================================================
1. Elsődleges: HungaroMet ODP (mért állomási adat)
   https://odp.met.hu/climate/observations_hungary/hourly/recent/
2. Fallback:   Open-Meteo ERA5 reanalysis
   https://archive-api.open-meteo.com/v1/archive

Hivatkozás:
  Mesterházy Á. et al. (1999) Plant Breeding 118:97-110
  Gyimes E. et al. (2012) Növényvédelem 48(8):347-352
"""

import os, sys, io, csv, zipfile, logging, argparse, requests, time
from datetime import datetime, timedelta, timezone, date
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

ODP_BASE  = "https://odp.met.hu/climate/observations_hungary/hourly/recent"
OM_BASE   = "https://archive-api.open-meteo.com/v1/archive"

STATION_IDS = {
    44309,44206,54201,54713,63510,64100,64716,43609,42409,
    35418,35315,36306,27815,37404,37713,29403,36605,
    23703,23201,15310,26505,34712,13704,24607,25820,34233,
    53509,53411,43113,32805,
}

# Állomás koordináták az Open-Meteo fallback-hez
STATION_COORDS = {
    44309: (46.2561, 20.0900),  54201: (47.1667, 20.1833),
    54713: (46.5667, 20.6667),  63510: (47.4900, 21.6153),
    64100: (47.9500, 21.7167),  64716: (47.1000, 20.7500),
    43609: (46.1947, 18.9583),  42409: (46.6167, 18.8567),
    44206: (46.9167, 19.7500),  35418: (47.3111, 18.7800),
    35315: (47.1900, 18.5836),  36306: (46.9033, 18.0478),
    27815: (46.3628, 17.8739),  37404: (46.0022, 18.2272),
    37713: (45.9833, 18.6833),  29403: (45.8675, 17.8511),
    36605: (46.3792, 18.1333),  23703: (47.7100, 17.6747),
    23201: (47.8897, 17.2672),  15310: (47.1983, 16.6478),
    26505: (46.7356, 17.2386),  34712: (47.4494, 18.5775),
    13704: (47.6783, 16.6022),  24607: (47.3706, 17.4964),
    25820: (47.0828, 17.9706),  34233: (47.5889, 18.3853),
    53509: (47.8983, 20.3753),  53411: (48.1000, 20.7833),
    43113: (47.4314, 19.1822),  32805: (48.0269, 18.8256),
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ"
)
log = logging.getLogger("fusarium-fetcher")

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; FusariumMonitor/2.0; MATE)"}


# ══════════════════════════════════════════════════════
# ODP FORRÁS
# ══════════════════════════════════════════════════════

def fetch_odp_station(station_id):
    """ODP recent CSV letöltése egy állomásra."""
    url = f"{ODP_BASE}/HABP_1H_{station_id}_recent.csv.zip"
    try:
        r = requests.get(url, headers=HEADERS, timeout=20)
        if r.status_code in (403, 404, 401):
            log.debug(f"  ODP HTTP {r.status_code} — fallback Open-Meteo")
            return None
        r.raise_for_status()
        return r.content
    except requests.RequestException as e:
        log.debug(f"  ODP hiba: {e}")
        return None


def parse_odp_csv(content, station_id, cutoff_dt):
    """ODP CSV feldolgozása."""
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            raw = zf.read(zf.namelist()[0]).decode("utf-8", errors="replace")
    except Exception as e:
        log.warning(f"  ZIP hiba: {e}")
        return []

    lines = raw.splitlines()
    header_idx = next((i for i, l in enumerate(lines) if not l.startswith("#") and l.strip()), None)
    if header_idx is None:
        return []

    reader = csv.DictReader(lines[header_idx:], delimiter=";")
    rows = []
    for row in reader:
        try:
            t_raw = next((row[k].strip() for k in ["Time","time","DATE","Időpont"] if k in row and row[k].strip()), "")
            if len(t_raw) < 8:
                continue
            obs_time = datetime.strptime(t_raw[:12].ljust(12,"0"), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
            if obs_time < cutoff_dt:
                continue

            def safe(cols):
                for c in cols:
                    v = row.get(c, "").strip()
                    if v and v not in ("-999","-999.0",""):
                        try: return round(float(v), 2)
                        except: pass
                return None

            temp = safe(["ta","Ta","T"])
            rh   = safe(["u","U","RH"])
            if temp is None and rh is None:
                continue

            rows.append({
                "station_id": station_id,
                "obs_time":   obs_time.isoformat(),
                "temp":       temp,
                "rh":         rh,
                "precip":     safe(["r","R"]),
                "wind_speed": safe(["fs","Fs"]),
                "source":     "ODP",
            })
        except Exception:
            continue
    return rows


# ══════════════════════════════════════════════════════
# OPEN-METEO FALLBACK
# ══════════════════════════════════════════════════════

def fetch_openmeteo_station(station_id, start_date, end_date):
    """Open-Meteo ERA5 historical adat lekérése."""
    if station_id not in STATION_COORDS:
        return []

    lat, lon = STATION_COORDS[station_id]
    params = {
        "latitude":  lat,
        "longitude": lon,
        "start_date": start_date.strftime("%Y-%m-%d"),
        "end_date":   end_date.strftime("%Y-%m-%d"),
        "hourly": "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m",
        "timezone": "UTC",
        "wind_speed_unit": "ms",
    }

    try:
        r = requests.get(OM_BASE, params=params, timeout=30)
        r.raise_for_status()
        d = r.json()
    except Exception as e:
        log.warning(f"  Open-Meteo hiba: {e}")
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
            temp = temps[i] if i < len(temps) else None
            rh   = rhs[i]   if i < len(rhs)   else None
            if temp is None and rh is None:
                continue
            rows.append({
                "station_id": station_id,
                "obs_time":   obs_time.isoformat(),
                "temp":       round(float(temp), 2) if temp is not None else None,
                "rh":         round(float(rh), 2)   if rh   is not None else None,
                "precip":     round(float(precs[i]), 2) if i < len(precs) and precs[i] is not None else None,
                "wind_speed": round(float(winds[i]), 2) if i < len(winds) and winds[i] is not None else None,
                "source":     "OpenMeteo-ERA5",
            })
        except Exception:
            continue

    return rows


# ══════════════════════════════════════════════════════
# UPSERT
# ══════════════════════════════════════════════════════

def upsert_rows(sb, rows, batch_size=500):
    total = 0
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i+batch_size]
        sb.table("hourly_obs").upsert(
            batch, on_conflict="station_id,obs_time"
        ).execute()
        total += len(batch)
    return total


# ══════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Fusarium kettős adatforrás letöltő")
    parser.add_argument("--days",    type=int, default=1, help="Hány napra visszamenőleg (max 30)")
    parser.add_argument("--no-calc", action="store_true")
    args = parser.parse_args()

    days = min(args.days, 30)
    cutoff_dt  = datetime.now(timezone.utc) - timedelta(days=days)
    start_date = (date.today() - timedelta(days=days))
    end_date   = date.today()

    log.info(f"Adatletöltés: {start_date} – {end_date} ({days} nap)")

    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    odp_ok = odp_fail = om_ok = om_fail = 0
    total_rows = 0

    for sid in sorted(STATION_IDS):
        rows = []

        # ── 1. ODP próba ──────────────────────────────
        content = fetch_odp_station(sid)
        if content:
            rows = parse_odp_csv(content, sid, cutoff_dt)
            if rows:
                log.info(f"  [{sid}] ODP ✓ → {len(rows)} sor")
                odp_ok += 1
            else:
                log.warning(f"  [{sid}] ODP: 0 feldolgozható sor → Open-Meteo")
                content = None

        # ── 2. Open-Meteo fallback ────────────────────
        if not content or not rows:
            rows = fetch_openmeteo_station(sid, start_date, end_date)
            if rows:
                log.info(f"  [{sid}] Open-Meteo ERA5 ✓ → {len(rows)} sor")
                om_ok += 1
            else:
                log.warning(f"  [{sid}] ✗ Mindkét forrás sikertelen")
                om_fail += 1
                continue

        # ── Feltöltés ─────────────────────────────────
        n = upsert_rows(sb, rows)
        total_rows += n
        time.sleep(0.1)  # API rate limit kímélet

    log.info("=" * 50)
    log.info(f"ODP sikeres:       {odp_ok} állomás")
    log.info(f"Open-Meteo ERA5:   {om_ok} állomás")
    log.info(f"Sikertelen:        {om_fail} állomás")
    log.info(f"Összesen betöltve: {total_rows} sor")
    log.info("=" * 50)


if __name__ == "__main__":
    main()
