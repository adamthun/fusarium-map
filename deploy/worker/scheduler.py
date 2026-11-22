#!/usr/bin/env python3
"""Egyszerű ütemező: naponta DAILY_HOUR órakor (helyi idő) lefuttatja a `daily` feladatot.
Induláskor (RUN_ON_START=1) azonnal is fut egyet, így egy leállás utáni újraindítás
automatikusan pótolja a kimaradt napokat."""
import logging, os, time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import jobs

TZ = ZoneInfo(os.environ.get("TZ_LOCAL", "Europe/Budapest"))
HOUR = int(os.environ.get("DAILY_HOUR", "7"))
log = logging.getLogger("scheduler")


def run():
    try:
        jobs.job_daily()
    except Exception:
        log.exception("A napi futás hibára futott — a következő ütemezett időpontban újrapróbálja.")


def next_run(now):
    t = now.replace(hour=HOUR, minute=0, second=0, microsecond=0)
    return t if t > now else t + timedelta(days=1)


if __name__ == "__main__":
    if os.environ.get("RUN_ON_START", "1") == "1":
        run()
    while True:
        nxt = next_run(datetime.now(TZ))
        log.info(f"Következő futás: {nxt:%Y-%m-%d %H:%M %Z}")
        while datetime.now(TZ) < nxt:
            time.sleep(min(600, max(1, (nxt - datetime.now(TZ)).total_seconds())))
        run()
