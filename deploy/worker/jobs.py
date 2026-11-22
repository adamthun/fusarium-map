#!/usr/bin/env python3
"""
Fusarium adatgyűjtő és kockázatszámító (saját üzemeltetés)
==========================================================
A GitHub Actions + Supabase pipeline (fetch_odp.py, gap_filler.py,
backfill_history.py, calc_risk.py) egy programba vonva, közvetlen
PostgreSQL kapcsolattal.

Adatforrás (kettős):
  1. HungaroMet ODP óránkénti mért adat (elsődleges)
  2. Open-Meteo: ERA5 archive (régebbi napok) / forecast API (utolsó ~5 nap)

Használat:
  python jobs.py daily                       # hiányzó szezonnapok + utolsó N nap frissítése
  python jobs.py backfill --years 2025 2026  # teljes szezon(ok) újratöltése
  python jobs.py calc --start 2026-05-01 --end 2026-05-31
  python jobs.py status

Modellek: Mesterházy Á. et al. (1999) Plant Breeding 118:97–110
          Gyimes E. et al. (2012) Növényvédelem 48(8):347–352
"""
import argparse, csv, io, logging, os, sys, time, zipfile
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import psycopg
import requests

DATABASE_URL  = os.environ["DATABASE_URL"]
TZ            = ZoneInfo(os.environ.get("TZ_LOCAL", "Europe/Budapest"))
REFRESH_DAYS  = int(os.environ.get("REFRESH_DAYS", "7"))   # ennyi napot mindig újraszámol (ERA5 korrekciók)
SEASON_START  = (4, 1)    # április 1.
SEASON_END    = (10, 31)  # október 31.
WINDOW        = 6         # a 7 napos ablakhoz ennyi nappal korábbról kell adat

ODP_BASE      = "https://odp.met.hu/climate/observations_hungary/hourly/recent"
OM_ARCHIVE    = "https://archive-api.open-meteo.com/v1/archive"
OM_FORECAST   = "https://api.open-meteo.com/v1/forecast"
ERA5_LAG_DAYS = 5
USE_ODP       = os.environ.get("USE_ODP", "1") == "1"
HEADERS       = {"User-Agent": "FusariumMonitor/3.0 (MATE)"}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fusarium-worker")


# ── Segédek ────────────────────────────────────────────────────
def db():
    return psycopg.connect(DATABASE_URL, autocommit=True)


def today_local() -> date:
    return datetime.now(TZ).date()


def season_bounds(year: int):
    return date(year, *SEASON_START), date(year, *SEASON_END)


def clamp_to_season(d: date) -> date:
    """A legutóbbi szezonbeli nap, ami <= d."""
    s, e = season_bounds(d.year)
    if d > e:
        return e
    if d < s:
        return season_bounds(d.year - 1)[1]
    return d


def stations(conn):
    return conn.execute(
        "SELECT station_id, lat::float, lon::float, name FROM stations WHERE is_active ORDER BY station_id"
    ).fetchall()


# ── ODP ────────────────────────────────────────────────────────
def fetch_odp(station_id, start: date, end: date):
    url = f"{ODP_BASE}/HABP_1H_{station_id}_recent.csv.zip"
    try:
        r = requests.get(url, headers=HEADERS, timeout=30)
        if r.status_code != 200:
            log.debug(f"  ODP HTTP {r.status_code}")
            return []
        with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
            raw = zf.read(zf.namelist()[0]).decode("utf-8", errors="replace")
    except Exception as e:
        log.debug(f"  ODP hiba: {e}")
        return []

    lines = raw.splitlines()
    hi = next((i for i, l in enumerate(lines) if l.strip() and not l.startswith("#")), None)
    if hi is None:
        return []
    t0 = datetime.combine(start, datetime.min.time(), timezone.utc)
    t1 = datetime.combine(end + timedelta(days=1), datetime.min.time(), timezone.utc)
    out = []
    for row in csv.DictReader(lines[hi:], delimiter=";"):
        row = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
        t_raw = next((row[k] for k in ("Time", "time", "DATE", "Időpont") if row.get(k)), "")
        if len(t_raw) < 8:
            continue
        try:
            ts = datetime.strptime(t_raw[:12].ljust(12, "0"), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if not (t0 <= ts < t1):
            continue

        def val(*cols):
            for c in cols:
                v = row.get(c, "")
                if v and v not in ("-999", "-999.0", "EOR"):
                    try:
                        return round(float(v), 1)
                    except ValueError:
                        pass
            return None

        temp, rh = val("ta", "Ta", "T"), val("u", "U", "RH")
        if temp is None and rh is None:
            continue
        out.append((station_id, ts, temp, rh, val("r", "R"), val("fs", "Fs"), "ODP"))
    return out


# ── Open-Meteo ─────────────────────────────────────────────────
def fetch_openmeteo(station_id, lat, lon, start: date, end: date):
    """Régebbi napok: ERA5 archive; az utolsó ~5 nap: forecast API (múltbeli órák)."""
    out = []
    split = today_local() - timedelta(days=ERA5_LAG_DAYS)
    parts = []
    if start <= min(end, split):
        parts.append((OM_ARCHIVE, start, min(end, split), "OpenMeteo-ERA5"))
    if end > split:
        parts.append((OM_FORECAST, max(start, split + timedelta(days=1)), end, "OpenMeteo-FC"))

    for url, s, e, src in parts:
        try:
            r = requests.get(url, params={
                "latitude": lat, "longitude": lon,
                "start_date": s.isoformat(), "end_date": e.isoformat(),
                "hourly": "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m",
                "timezone": "UTC", "wind_speed_unit": "ms",
            }, headers=HEADERS, timeout=60)
            r.raise_for_status()
            h = r.json().get("hourly", {})
        except Exception as ex:
            log.warning(f"  [{station_id}] Open-Meteo hiba ({src}): {ex}")
            continue
        T, RH = h.get("temperature_2m", []), h.get("relative_humidity_2m", [])
        P, W = h.get("precipitation", []), h.get("wind_speed_10m", [])
        for i, t in enumerate(h.get("time", [])):
            temp = T[i] if i < len(T) else None
            rh = RH[i] if i < len(RH) else None
            if temp is None and rh is None:
                continue
            ts = datetime.fromisoformat(t).replace(tzinfo=timezone.utc)
            rnd = lambda a: round(float(a[i]), 1) if i < len(a) and a[i] is not None else None
            out.append((station_id, ts,
                        round(float(temp), 1) if temp is not None else None,
                        round(float(rh), 1) if rh is not None else None,
                        rnd(P), rnd(W), src))
    return out


# ── Betöltés ───────────────────────────────────────────────────
UPSERT = """
INSERT INTO hourly_obs (station_id, obs_time, temp, rh, precip, wind_speed, source)
VALUES (%s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (station_id, obs_time) DO UPDATE
  SET temp = EXCLUDED.temp, rh = EXCLUDED.rh, precip = EXCLUDED.precip,
      wind_speed = EXCLUDED.wind_speed, source = EXCLUDED.source, imported_at = now()
  -- mért (ODP) adatot modelladat nem ír felül
  WHERE hourly_obs.source <> 'ODP' OR EXCLUDED.source = 'ODP'
"""


def load(conn, rows):
    if not rows:
        return 0
    with conn.cursor() as cur:
        cur.executemany(UPSERT, rows)
    return len(rows)


def fetch_range(conn, start: date, end: date, try_odp: bool):
    log.info(f"Adatletöltés {start} – {end}")
    stats = {"ODP": 0, "OpenMeteo": 0, "hiba": 0, "sor": 0}
    for sid, lat, lon, name in stations(conn):
        rows = fetch_odp(sid, start, end) if (try_odp and USE_ODP) else []
        if rows:
            stats["ODP"] += 1
        else:
            rows = fetch_openmeteo(sid, lat, lon, start, end)
            stats["OpenMeteo" if rows else "hiba"] += 1
        stats["sor"] += load(conn, rows)
        log.info(f"  [{sid}] {name}: {len(rows)} sor ({rows[0][-1] if rows else '—'})")
        time.sleep(0.15)
    log.info(f"Letöltés kész: {stats}")
    return stats


def calc(conn, start: date, end: date):
    end = min(end, today_local() - timedelta(days=1))
    if start > end:
        log.info("Nincs számítandó nap.")
        return
    log.info(f"Kockázatszámítás {start} – {end}")
    res = conn.execute("SELECT * FROM compute_daily_risk_range(%s, %s)", (start, end)).fetchall()
    log.info(f"  {len(res)} nap kiszámítva (mindkét modell)")


# ── Feladatok ──────────────────────────────────────────────────
def job_daily():
    """Pótolja a hiányzó szezonnapokat az utolsó számított naptól tegnapig,
    és az utolsó REFRESH_DAYS napot újraszámolja (pontosodó ERA5 adatok)."""
    with db() as conn:
        end = clamp_to_season(today_local() - timedelta(days=1))
        s_start, _ = season_bounds(end.year)
        last = conn.execute("SELECT max(calc_date) FROM fusarium_risk").fetchone()[0]
        start = s_start if (last is None or last < s_start) else min(last + timedelta(days=1),
                                                                     end - timedelta(days=REFRESH_DAYS - 1))
        start = max(start, s_start)
        if start > end:
            log.info(f"Szezonon kívül / naprakész (utolsó: {last}).")
            return
        fetch_range(conn, start - timedelta(days=WINDOW), end, try_odp=True)
        calc(conn, start, end)


def job_backfill(years):
    with db() as conn:
        for y in years:
            s, e = season_bounds(y)
            e = min(e, today_local() - timedelta(days=1))
            if s > e:
                log.warning(f"{y}: még nincs szezonnap")
                continue
            log.info(f"═══ {y} szezon: {s} – {e} ═══")
            fetch_range(conn, s - timedelta(days=WINDOW), e, try_odp=False)
            calc(conn, s, e)


def job_calc(start, end):
    with db() as conn:
        calc(conn, start, end)


def job_status():
    with db() as conn:
        for q, label in [
            ("SELECT count(*) FROM stations WHERE is_active", "aktív állomás"),
            ("SELECT count(*) FROM hourly_obs", "órás mérés"),
            ("SELECT max(obs_time) FROM hourly_obs", "utolsó mérés"),
            ("SELECT count(*) FROM fusarium_risk", "kockázati sor"),
            ("SELECT min(calc_date)||' – '||max(calc_date) FROM fusarium_risk", "számított napok"),
        ]:
            print(f"{label:>18}: {conn.execute(q).fetchone()[0]}")
        for src, n in conn.execute("SELECT source, count(*) FROM hourly_obs GROUP BY 1 ORDER BY 2 DESC"):
            print(f"{'forrás ' + str(src):>18}: {n}")


def main(argv=None):
    p = argparse.ArgumentParser(description="Fusarium worker")
    sp = p.add_subparsers(dest="cmd", required=True)
    sp.add_parser("daily")
    b = sp.add_parser("backfill"); b.add_argument("--years", nargs="+", type=int, required=True)
    c = sp.add_parser("calc")
    c.add_argument("--start", type=date.fromisoformat, required=True)
    c.add_argument("--end", type=date.fromisoformat, required=True)
    sp.add_parser("status")
    a = p.parse_args(argv)
    {"daily": job_daily, "status": job_status}.get(a.cmd, lambda: None)()
    if a.cmd == "backfill":
        job_backfill(a.years)
    elif a.cmd == "calc":
        job_calc(a.start, a.end)


if __name__ == "__main__":
    sys.exit(main())
