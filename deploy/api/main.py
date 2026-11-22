"""
Fusarium API — a Supabase Edge Function (fusarium-api) saját üzemeltetésű megfelelője.
Ugyanaz a végpont és JSON-forma, így a frontend változtatás nélkül működik:
  GET /api/fusarium-api?action=dates
  GET /api/fusarium-api?action=risk&date=YYYY-MM-DD&model=1|2
  GET /api/fusarium-api?action=stations
  GET /api/health
"""
import os
from datetime import date, datetime
from decimal import Decimal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

DATABASE_URL = os.environ["DATABASE_URL"]
pool = ConnectionPool(DATABASE_URL, min_size=1, max_size=5, kwargs={"row_factory": dict_row}, open=True)

app = FastAPI(title="Fusarium API", docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
                   allow_methods=["GET"], allow_headers=["*"])


def _json(v):
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    return v


def rows(sql, params=()):
    with pool.connection() as conn:
        cur = conn.execute(sql, params)
        return [{k: _json(v) for k, v in r.items()} for r in cur.fetchall()]


@app.get("/api/health")
def health():
    r = rows("SELECT max(calc_date) AS last_calc, (SELECT max(obs_time) FROM hourly_obs) AS last_obs FROM fusarium_risk")
    return {"status": "ok", **r[0]}


@app.get("/api/fusarium-api")
def fusarium_api(action: str = Query("risk"), date: str | None = None, model: int = 1):
    if action == "dates":
        d = rows("SELECT calc_date FROM get_available_dates()")
        return {"dates": [x["calc_date"] for x in d]}

    if action == "risk":
        if model not in (1, 2):
            raise HTTPException(400, "model: 1 vagy 2")
        if date:
            data = rows("SELECT * FROM v_risk_map WHERE model_id=%s AND calc_date=%s ORDER BY risk_pct DESC",
                        (model, date))
        else:
            data = rows("""SELECT * FROM v_risk_map WHERE model_id=%s
                           AND calc_date=(SELECT max(calc_date) FROM fusarium_risk WHERE model_id=%s)
                           ORDER BY risk_pct DESC""", (model, model))
        return JSONResponse({"data": data}, headers={"Cache-Control": "public, max-age=300"})

    if action == "stations":
        return {"data": rows("SELECT * FROM v_station_coverage ORDER BY station_id")}

    raise HTTPException(400, "Ismeretlen action (dates | risk | stations)")
