#!/usr/bin/env python3
"""
Fusarium kockázatszámítás
Mesterházy Á. et al. (1999) Plant Breeding 118:97-110
Gyimes E. et al. (2012) Növényvédelem 48(8):347-352
"""

import os
import sys
import argparse
from datetime import datetime, timedelta
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

def calc_trh9010(station_id, calc_date, sb):
    """Modell 1: p% = -3.3756 + 6.8128 * TRH9010"""
    window_start = (calc_date - timedelta(days=6)).isoformat()
    window_end   = (calc_date + timedelta(days=1)).isoformat()

    resp = sb.table("hourly_obs")\
        .select("obs_time,temp,rh")\
        .eq("station_id", station_id)\
        .gte("obs_time", window_start)\
        .lt("obs_time", window_end)\
        .order("obs_time")\
        .execute()

    rows = resp.data or []
    if not rows:
        return None

    consec = 0
    max_consec = 0
    for r in rows:
        t = r.get("temp")
        rh = r.get("rh")
        if t is None or rh is None:
            consec = 0
            continue
        if rh > 90 and 15 <= t <= 30:
            consec += 1
            max_consec = max(max_consec, consec)
        else:
            consec = 0

    p = max(0, min(100, -3.3756 + 6.8128 * max_consec))
    return {"trh9010_hours": max_consec, "risk_pct": round(p, 2), "obs_count": len(rows)}


def calc_int3(station_id, calc_date, sb, flowering_day=4):
    """Modell 2: p% = -3.7251 + 10.5097 * INT3"""
    window_start  = (calc_date - timedelta(days=6)).isoformat()
    window_end    = (calc_date + timedelta(days=1)).isoformat()
    flower_ts     = (calc_date - timedelta(days=6) + timedelta(days=flowering_day-1)).isoformat()

    resp = sb.table("hourly_obs")\
        .select("obs_time,temp,rh")\
        .eq("station_id", station_id)\
        .gte("obs_time", window_start)\
        .lt("obs_time", window_end)\
        .order("obs_time")\
        .execute()

    rows = resp.data or []
    if not rows:
        return None

    pre_total = pre_warm = 0
    post_consec = post_max = 0

    for r in rows:
        t  = r.get("temp")
        rh = r.get("rh")
        if t is None or rh is None:
            continue
        if r["obs_time"] < flower_ts:
            pre_total += 1
            if 15 <= t <= 30:
                pre_warm += 1
        else:
            if rh > 90:
                post_consec += 1
                post_max = max(post_max, post_consec)
            else:
                post_consec = 0

    temp_ratio = pre_warm / max(1, pre_total)
    int3 = post_max * temp_ratio
    p = max(0, min(100, -3.7251 + 10.5097 * int3))

    return {
        "int3_value": round(int3, 4),
        "risk_pct": round(p, 2),
        "flowering_day": flowering_day,
        "obs_count": len(rows)
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", help="Dátum YYYY-MM-DD (alapért: tegnap)")
    args = parser.parse_args()

    if args.date:
        calc_date = datetime.strptime(args.date, "%Y-%m-%d").date()
    else:
        calc_date = (datetime.utcnow() - timedelta(days=1)).date()

    print(f"Kockázatszámítás: {calc_date}")

    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # Aktív állomások lekérése
    stations = sb.table("stations").select("station_id,name").eq("is_active", True).execute()
    station_list = stations.data or []
    print(f"Állomások: {len(station_list)}")

    ok = 0
    for s in station_list:
        sid  = s["station_id"]
        name = s["name"]

        # Modell 1
        r1 = calc_trh9010(sid, calc_date, sb)
        if r1:
            sb.table("fusarium_risk").upsert({
                "station_id":     sid,
                "calc_date":      calc_date.isoformat(),
                "model_id":       1,
                "risk_pct":       r1["risk_pct"],
                "trh9010_hours":  r1["trh9010_hours"],
                "window_start":   (calc_date - timedelta(days=6)).isoformat(),
                "window_end":     calc_date.isoformat(),
                "obs_count":      r1["obs_count"],
            }, on_conflict="station_id,calc_date,model_id").execute()

        # Modell 2
        r2 = calc_int3(sid, calc_date, sb)
        if r2:
            sb.table("fusarium_risk").upsert({
                "station_id":    sid,
                "calc_date":     calc_date.isoformat(),
                "model_id":      2,
                "risk_pct":      r2["risk_pct"],
                "int3_value":    r2["int3_value"],
                "flowering_day": r2["flowering_day"],
                "obs_count":     r2["obs_count"],
            }, on_conflict="station_id,calc_date,model_id").execute()

        if r1 or r2:
            ok += 1
            print(f"  ✓ {name}: M1={r1['risk_pct'] if r1 else '-'}%, M2={r2['risk_pct'] if r2 else '-'}%")

    print(f"Kész: {ok}/{len(station_list)} állomás")


if __name__ == "__main__":
    main()
