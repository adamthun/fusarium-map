-- ══════════════════════════════════════════════════════════════
-- Fusarium kockázati térkép — adatbázis séma (saját üzemeltetés)
-- Modell: Mesterházy Á. et al. (1999) Plant Breeding 118:97–110
--         Gyimes E. et al. (2012) Növényvédelem 48(8):347–352
-- A Supabase-es éles séma pontos megfelelője, Supabase-specifikus
-- elemek (RLS, auth.role) nélkül. Csak az első induláskor fut le
-- (üres adatkönyvtárnál), a postgres konténer automatikusan futtatja.
-- ══════════════════════════════════════════════════════════════

-- ── 1. ÁLLOMÁSOK ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stations (
  station_id    INTEGER PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  lat           NUMERIC(6,4) NOT NULL,
  lon           NUMERIC(6,4) NOT NULL,
  elevation     NUMERIC(5,1),
  county        VARCHAR(50),
  region        VARCHAR(20),            -- 'alfold' | 'dunantul' | 'eszak'
  wheat_area    BOOLEAN DEFAULT true,
  is_active     BOOLEAN DEFAULT true,
  odp_file_id   VARCHAR(20),
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ── 2. ÓRÁNKÉNTI MÉRÉSEK ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS hourly_obs (
  station_id  INTEGER NOT NULL REFERENCES stations(station_id),
  obs_time    TIMESTAMPTZ NOT NULL,
  temp        NUMERIC(4,1),             -- ODP ta / Open-Meteo temperature_2m (°C)
  rh          NUMERIC(4,1),             -- ODP u  / Open-Meteo relative_humidity_2m (%)
  precip      NUMERIC(5,1),             -- mm/h
  wind_speed  NUMERIC(4,1),             -- m/s
  pressure    NUMERIC(6,1),             -- hPa
  global_rad  NUMERIC(6,1),             -- J/cm²
  imported_at TIMESTAMPTZ DEFAULT now(),
  source      VARCHAR(20) DEFAULT 'ODP',-- 'ODP' | 'OpenMeteo-ERA5' | 'OpenMeteo-FC'
  PRIMARY KEY (station_id, obs_time)
);

-- ── 3. FUSARIUM KOCKÁZAT ─────────────────────────────────────
-- model_id 1 = TRH9010:  p% = -3.3756 + 6.8128 * TRH9010
-- model_id 2 = INT3:     p% = -3.7251 + 10.5097 * INT3
CREATE TABLE IF NOT EXISTS fusarium_risk (
  station_id      INTEGER NOT NULL REFERENCES stations(station_id),
  calc_date       DATE NOT NULL,
  model_id        SMALLINT NOT NULL,
  risk_pct        NUMERIC(6,2),
  trh9010_hours   NUMERIC(5,1),
  int3_value      NUMERIC(7,4),
  flowering_day   SMALLINT,
  window_start    DATE,
  window_end      DATE,
  obs_count       INTEGER,
  calc_params     JSONB,
  calculated_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (station_id, calc_date, model_id)
);

CREATE INDEX IF NOT EXISTS idx_hourly_obs_time      ON hourly_obs (obs_time DESC);
CREATE INDEX IF NOT EXISTS idx_hourly_obs_sta_time  ON hourly_obs (station_id, obs_time DESC);
CREATE INDEX IF NOT EXISTS idx_hourly_obs_temp_rh   ON hourly_obs (obs_time, temp, rh);
CREATE INDEX IF NOT EXISTS idx_hourly_obs_source    ON hourly_obs (source);
CREATE INDEX IF NOT EXISTS idx_risk_date_model      ON fusarium_risk (calc_date DESC, model_id);
CREATE INDEX IF NOT EXISTS idx_risk_station_date    ON fusarium_risk (station_id, calc_date DESC);

-- ── 4. KOCKÁZATSZÁMÍTÁS DÁTUMTARTOMÁNYRA ─────────────────────
-- Minden napra a megelőző 7 napos ablakból (d-6 .. d) számol,
-- mindkét modellel, upsert-tel (újrafuttatható).
CREATE OR REPLACE FUNCTION compute_daily_risk_range(p_start DATE, p_end DATE)
RETURNS SETOF TEXT LANGUAGE plpgsql AS $$
DECLARE
  d DATE;
  n INT;
BEGIN
  d := p_start;
  WHILE d <= p_end LOOP
    -- Modell 1: TRH9010 — leghosszabb egybefüggő RH>90% ÉS 15–30 °C órasorozat
    INSERT INTO fusarium_risk
      (station_id, calc_date, model_id, risk_pct, trh9010_hours, window_start, window_end, obs_count)
    WITH station_hours AS (
      SELECT h.station_id,
        CASE WHEN h.rh > 90 AND h.temp >= 15 AND h.temp <= 30 THEN 1 ELSE 0 END AS meets,
        ROW_NUMBER() OVER (PARTITION BY h.station_id ORDER BY h.obs_time)
        - ROW_NUMBER() OVER (PARTITION BY h.station_id,
            CASE WHEN h.rh > 90 AND h.temp >= 15 AND h.temp <= 30 THEN 1 ELSE 0 END
            ORDER BY h.obs_time) AS grp
      FROM hourly_obs h
      WHERE h.obs_time >= (d - 6)::TIMESTAMPTZ
        AND h.obs_time <  (d + 1)::TIMESTAMPTZ
        AND h.temp IS NOT NULL AND h.rh IS NOT NULL
    ),
    runs AS (
      SELECT station_id, grp, COUNT(*) AS run_len
      FROM station_hours WHERE meets = 1 GROUP BY station_id, grp
    ),
    max_runs AS (
      SELECT station_id, COALESCE(MAX(run_len), 0) AS trh9010 FROM runs GROUP BY station_id
    ),
    obs_cnt AS (
      SELECT station_id, COUNT(*) AS cnt FROM hourly_obs
      WHERE obs_time >= (d - 6)::TIMESTAMPTZ AND obs_time < (d + 1)::TIMESTAMPTZ
      GROUP BY station_id
    )
    SELECT s.station_id, d, 1,
      GREATEST(0, LEAST(100, -3.3756 + 6.8128 * COALESCE(mr.trh9010, 0))),
      COALESCE(mr.trh9010, 0), d - 6, d, COALESCE(oc.cnt, 0)
    FROM stations s
    LEFT JOIN max_runs mr ON s.station_id = mr.station_id
    LEFT JOIN obs_cnt  oc ON s.station_id = oc.station_id
    WHERE s.is_active = true
      AND EXISTS (SELECT 1 FROM hourly_obs h WHERE h.station_id = s.station_id
                  AND h.obs_time >= (d - 6)::TIMESTAMPTZ AND h.obs_time < (d + 1)::TIMESTAMPTZ)
    ON CONFLICT (station_id, calc_date, model_id) DO UPDATE
      SET risk_pct = EXCLUDED.risk_pct, trh9010_hours = EXCLUDED.trh9010_hours,
          window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
          obs_count = EXCLUDED.obs_count, calculated_at = now();

    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN NEXT d::TEXT || ' M1:' || n;

    -- Modell 2: INT3 — virágzás (ablak 4. napja) előtti 15–30 °C arány
    --                 × virágzás utáni leghosszabb egybefüggő RH>90% sorozat
    INSERT INTO fusarium_risk
      (station_id, calc_date, model_id, risk_pct, int3_value, flowering_day, window_start, window_end, obs_count)
    WITH pre AS (
      SELECT station_id,
        COUNT(*) FILTER (WHERE temp >= 15 AND temp <= 30) AS warm,
        COUNT(*) AS total
      FROM hourly_obs
      WHERE obs_time >= (d - 6)::TIMESTAMPTZ AND obs_time < (d - 3)::TIMESTAMPTZ
        AND temp IS NOT NULL
      GROUP BY station_id
    ),
    post_hours AS (
      SELECT station_id, rh,
        ROW_NUMBER() OVER (PARTITION BY station_id ORDER BY obs_time)
        - ROW_NUMBER() OVER (PARTITION BY station_id,
            CASE WHEN rh > 90 THEN 1 ELSE 0 END ORDER BY obs_time) AS grp
      FROM hourly_obs
      WHERE obs_time >= (d - 3)::TIMESTAMPTZ AND obs_time < (d + 1)::TIMESTAMPTZ
        AND rh IS NOT NULL
    ),
    post_max AS (
      SELECT station_id, COALESCE(MAX(run_len), 0) AS max_rh
      FROM (SELECT station_id, grp, COUNT(*) AS run_len
            FROM post_hours WHERE rh > 90 GROUP BY station_id, grp) x
      GROUP BY station_id
    )
    SELECT s.station_id, d, 2,
      GREATEST(0, LEAST(100, -3.7251 + 10.5097 *
        (COALESCE(pm.max_rh,0) *
         CASE WHEN COALESCE(pr.total,0) > 0 THEN pr.warm::NUMERIC / pr.total ELSE 0 END))),
      ROUND((COALESCE(pm.max_rh,0) *
         CASE WHEN COALESCE(pr.total,0) > 0 THEN pr.warm::NUMERIC / pr.total ELSE 0 END)::NUMERIC, 4),
      4, d - 6, d, COALESCE(pr.total, 0)
    FROM stations s
    LEFT JOIN pre pr      ON s.station_id = pr.station_id
    LEFT JOIN post_max pm ON s.station_id = pm.station_id
    WHERE s.is_active = true
      AND EXISTS (SELECT 1 FROM hourly_obs h WHERE h.station_id = s.station_id
                  AND h.obs_time >= (d - 6)::TIMESTAMPTZ AND h.obs_time < (d + 1)::TIMESTAMPTZ)
    ON CONFLICT (station_id, calc_date, model_id) DO UPDATE
      SET risk_pct = EXCLUDED.risk_pct, int3_value = EXCLUDED.int3_value,
          flowering_day = EXCLUDED.flowering_day,
          window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
          obs_count = EXCLUDED.obs_count, calculated_at = now();

    d := d + 1;
  END LOOP;
END;
$$;

-- Egyállomásos segédfüggvények és egynapos számítás — az éles adatbázisból
-- változtatás nélkül átvéve (kompatibilitás, ellenőrzés, hibakeresés).
CREATE OR REPLACE FUNCTION calc_model1_trh9010(p_station_id integer, p_end_date date)
 RETURNS TABLE(trh9010_hours integer, risk_pct numeric, obs_count integer, window_start date, window_end date)
 LANGUAGE plpgsql AS $function$
DECLARE
  v_start    TIMESTAMPTZ := (p_end_date - 6)::TIMESTAMPTZ;
  v_end      TIMESTAMPTZ := (p_end_date + 1)::TIMESTAMPTZ;
  rec        RECORD;
  consec     INT := 0;
  max_consec INT := 0;
  cnt        INT := 0;
BEGIN
  FOR rec IN
    SELECT obs_time, temp, rh FROM hourly_obs
    WHERE station_id = p_station_id AND obs_time >= v_start AND obs_time < v_end
      AND temp IS NOT NULL AND rh IS NOT NULL
    ORDER BY obs_time ASC
  LOOP
    cnt := cnt + 1;
    IF rec.rh > 90 AND rec.temp >= 15 AND rec.temp <= 30 THEN
      consec := consec + 1; max_consec := GREATEST(max_consec, consec);
    ELSE
      consec := 0;
    END IF;
  END LOOP;
  trh9010_hours := max_consec;
  risk_pct      := GREATEST(0, LEAST(100, -3.3756 + 6.8128 * max_consec));
  obs_count     := cnt;
  window_start  := p_end_date - 6;
  window_end    := p_end_date;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION calc_model2_int3(p_station_id integer, p_end_date date, p_flower_day integer DEFAULT 4)
 RETURNS TABLE(int3_value numeric, risk_pct numeric, pre_temp_ratio numeric, post_rh_hours integer, obs_count integer)
 LANGUAGE plpgsql AS $function$
DECLARE
  v_start      TIMESTAMPTZ := (p_end_date - 6)::TIMESTAMPTZ;
  v_flower_ts  TIMESTAMPTZ := (p_end_date - 6 + p_flower_day - 1)::TIMESTAMPTZ;
  v_end        TIMESTAMPTZ := (p_end_date + 1)::TIMESTAMPTZ;
  rec          RECORD;
  pre_total    INT := 0;
  pre_warm     INT := 0;
  post_consec  INT := 0;
  post_max     INT := 0;
  cnt          INT := 0;
  v_int3       NUMERIC;
BEGIN
  FOR rec IN
    SELECT obs_time, temp, rh FROM hourly_obs
    WHERE station_id = p_station_id AND obs_time >= v_start AND obs_time < v_end
      AND temp IS NOT NULL AND rh IS NOT NULL
    ORDER BY obs_time ASC
  LOOP
    cnt := cnt + 1;
    IF rec.obs_time < v_flower_ts THEN
      pre_total := pre_total + 1;
      IF rec.temp >= 15 AND rec.temp <= 30 THEN pre_warm := pre_warm + 1; END IF;
    ELSE
      IF rec.rh > 90 THEN
        post_consec := post_consec + 1; post_max := GREATEST(post_max, post_consec);
      ELSE
        post_consec := 0;
      END IF;
    END IF;
  END LOOP;
  v_int3 := post_max * CASE WHEN pre_total > 0 THEN pre_warm::NUMERIC / pre_total ELSE 0 END;
  int3_value     := ROUND(v_int3, 4);
  risk_pct       := GREATEST(0, LEAST(100, -3.7251 + 10.5097 * v_int3));
  pre_temp_ratio := CASE WHEN pre_total > 0 THEN ROUND(pre_warm::NUMERIC / pre_total, 3) ELSE 0 END;
  post_rh_hours  := post_max;
  obs_count      := cnt;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION compute_daily_risk(p_date date)
 RETURNS TABLE(station_id integer, name character varying, model_id integer, risk_pct numeric, param numeric, obs_count integer)
 LANGUAGE plpgsql AS $function$
DECLARE
  s RECORD; r1 RECORD; r2 RECORD;
BEGIN
  FOR s IN SELECT st.station_id, st.name FROM stations st WHERE st.is_active LOOP
    SELECT * INTO r1 FROM calc_model1_trh9010(s.station_id, p_date);
    IF r1.obs_count > 0 THEN
      INSERT INTO fusarium_risk (station_id, calc_date, model_id, risk_pct, trh9010_hours,
                                 window_start, window_end, obs_count, calculated_at)
      VALUES (s.station_id, p_date, 1, r1.risk_pct, r1.trh9010_hours,
              r1.window_start, r1.window_end, r1.obs_count, now())
      ON CONFLICT ON CONSTRAINT fusarium_risk_pkey
      DO UPDATE SET risk_pct=EXCLUDED.risk_pct, trh9010_hours=EXCLUDED.trh9010_hours,
                    obs_count=EXCLUDED.obs_count, calculated_at=now();
      station_id := s.station_id; name := s.name; model_id := 1;
      risk_pct := r1.risk_pct; param := r1.trh9010_hours; obs_count := r1.obs_count;
      RETURN NEXT;
    END IF;
    SELECT * INTO r2 FROM calc_model2_int3(s.station_id, p_date, 4);
    IF r2.obs_count > 0 THEN
      INSERT INTO fusarium_risk (station_id, calc_date, model_id, risk_pct, int3_value,
                                 flowering_day, obs_count, calculated_at)
      VALUES (s.station_id, p_date, 2, r2.risk_pct, r2.int3_value, 4, r2.obs_count, now())
      ON CONFLICT ON CONSTRAINT fusarium_risk_pkey
      DO UPDATE SET risk_pct=EXCLUDED.risk_pct, int3_value=EXCLUDED.int3_value,
                    obs_count=EXCLUDED.obs_count, calculated_at=now();
      station_id := s.station_id; name := s.name; model_id := 2;
      risk_pct := r2.risk_pct; param := r2.int3_value; obs_count := r2.obs_count;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$function$;

-- ── 5. NÉZETEK (az API ezeket olvassa) ───────────────────────
CREATE OR REPLACE VIEW v_risk_map AS
SELECT
  fr.station_id,
  s.name          AS station_name,
  s.lat::FLOAT    AS lat,
  s.lon::FLOAT    AS lon,
  s.county, s.region, s.wheat_area,
  fr.calc_date, fr.model_id,
  ROUND(fr.risk_pct::NUMERIC, 2) AS risk_pct,
  fr.trh9010_hours, fr.int3_value, fr.flowering_day, fr.obs_count,
  fr.window_start, fr.window_end, fr.calculated_at
FROM fusarium_risk fr
JOIN stations s ON s.station_id = fr.station_id
WHERE s.is_active = true;

CREATE OR REPLACE VIEW v_station_coverage AS
SELECT
  s.station_id, s.name, s.lat, s.lon, s.county, s.region, s.wheat_area,
  COUNT(h.obs_time)                    AS total_obs,
  MAX(h.obs_time)                      AS last_obs,
  MIN(h.obs_time)                      AS first_obs,
  ROUND(AVG(h.temp)::NUMERIC, 1)       AS avg_temp,
  ROUND(AVG(h.rh)::NUMERIC, 1)         AS avg_rh,
  COUNT(*) FILTER (WHERE h.obs_time >= now() - interval '7 days') AS obs_last_7d
FROM stations s
LEFT JOIN hourly_obs h ON h.station_id = s.station_id
GROUP BY s.station_id, s.name, s.lat, s.lon, s.county, s.region, s.wheat_area;

CREATE OR REPLACE VIEW v_available_dates AS
SELECT DISTINCT calc_date FROM fusarium_risk
WHERE calc_date >= '2024-04-01' ORDER BY calc_date DESC;

CREATE OR REPLACE FUNCTION get_available_dates()
RETURNS TABLE(calc_date DATE) LANGUAGE sql STABLE AS $$
  SELECT DISTINCT calc_date FROM fusarium_risk
  WHERE calc_date >= '2024-04-01' ORDER BY calc_date DESC;
$$;
