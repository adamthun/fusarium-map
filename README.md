# 🌾 Fusarium Kockázati Térkép

Fusarium fertőzési kockázat becslő térkép Magyarország számára,
HungaroMet ODP meteorológiai adatok alapján.

**Modell forrás:**
> Mesterházy Á., Bartók T., Mirocha C.G., Komoroczy R. (1999):
> *Nature of wheat resistance to Fusarium head blight and the role of deoxynivalenol for breeding.*
> **Plant Breeding** 118: 97–110. DOI: 10.1046/j.1439-0523.1999.118001097.x

> Gyimes E., Véha A., Szabó B.P., Galbács Z. (2012):
> *Fusarium fertőzés előrejelzése meteorológiai adatok alapján.*
> **Növényvédelem** 48(8): 347–352.

---

## Architektúra

```
HungaroMet ODP
      │  (óránkénti CSV)
      ▼
GitHub Actions          ← óránként fut (cron: 45 * * * *)
  fetch_odp.py
      │  (upsert)
      ▼
Supabase PostgreSQL
  ├── stations        (30 OMSZ állomás)
  ├── hourly_obs      (ta, u, r, fs óránkénti adatok)
  └── fusarium_risk   (TRH9010 + INT3 napi kockázat)
      │
      ▼  (Edge Function + REST API)
Vercel (React)
  └── interaktív SVG térkép
```

---

## Telepítés

### 1. Repository klónozása

```bash
git clone https://github.com/TE_FELHASZNALONEVED/fusarium-map.git
cd fusarium-map
```

### 2. Környezeti változók

```bash
cp .env.example .env
# Szerkeszd a .env fájlt — add meg a Supabase anon kulcsot
```

### 3. Helyi fejlesztés

```bash
npm install
npm start
# → http://localhost:3000
```

### 4. GitHub Secrets beállítása

GitHub repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret neve          | Értéke                              |
|---------------------|-------------------------------------|
| `SUPABASE_URL`       | `https://daelyokkshcgtbijcfbz.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API → `service_role` kulcs |
| `SUPABASE_ANON_KEY`  | Supabase → Settings → API → `anon` kulcs |

### 5. Vercel deploy

```bash
npm install -g vercel
vercel login
vercel --prod
```

Vagy: GitHub repo csatlakoztatása a Vercel dashboardon → automatikus deploy minden push után.

**Vercel Environment Variables** (Project → Settings → Environment Variables):
- `REACT_APP_SUPABASE_URL`
- `REACT_APP_SUPABASE_ANON_KEY`

---

## GitHub Actions — Automatikus pipeline

A `.github/workflows/fusarium-pipeline.yml` workflow:

| Időpont (UTC) | Feladat |
|--------------|---------|
| `45 * * * *` | ODP CSV letöltés → Supabase upsert |
| `0 6 * * *`  | Napi Fusarium kockázatszámítás (mindkét modell) |

**Manuális futtatás** (Actions → Fusarium ODP Adatgyűjtő → Run workflow):
- Megadható dátum, napok száma, és mód (fetch/calc/both)
- Hasznos backfill esetén

---

## Fusarium modellek

### Modell 1: TRH9010
```
p% = −3.3756 + 6.8128 × TRH9010
```
- TRH9010 = 7 napos mozgó ablakban a leghosszabb egybefüggő órasorozat,
  amelyben: **RH > 90%** ÉS **15°C ≤ T ≤ 30°C**
- ODP adatok: `ta` (hőmérséklet), `u` (relatív nedvesség)

### Modell 2: INT3 (interakciós)
```
p% = −3.7251 + 10.5097 × INT3
INT3 = (virágzás utáni max. egybefüggő RH>90% óra) ×
       (virágzás előtti 15–30°C arány)
```
- Virágzás napja: alapértelmezetten a 7-napos ablak 4. napja
- Alkalmazható: virágzást megelőző és azt követő időszakra

---

## Állomáshálózat (30 db)

| Régió         | Db | Fontosabb állomások |
|--------------|----|---------------------|
| Nagyalföld    |  9 | Szeged, Kecskemét, Orosháza, Debrecen, Szolnok |
| Dunántúl      | 17 | Martonvásár★, Győr, Pécs, Kaposvár, Siófok |
| Észak-Mo.    |  4 | Eger, Miskolc, Budapest, Tésa |

★ **Martonvásár** — MTA ATK búzakutatási referencia állomás

---

## Adatforrás

- **HungaroMet ODP szinoptikus óránkénti adatok**
  `https://odp.met.hu/weather/weather_reports/synoptic/hungary/hourly/`
- Fájlformátum: `HABP_1H_YYYYMMDD.csv.zip`
- Releváns CSV oszlopok:
  - `StationNumber` — állomásszám
  - `Time` — időbélyeg (YYYYMMDDHHmm UTC)
  - `ta` — átlaghőmérséklet (°C), adathiány: -999
  - `u` — relatív nedvesség (%), adathiány: -999
  - `r` — csapadék (mm/h)
  - `fs` — szélsebesség (m/s)

---

## Manuális adatletöltés

```bash
cd scripts
pip install -r requirements.txt

# Tegnapi adat:
python fetch_odp.py

# Adott nap:
python fetch_odp.py --date 2026-05-15

# Visszamenőleges (7 nap):
python fetch_odp.py --days 7

# Csak letöltés számítás nélkül:
python fetch_odp.py --no-calc
```

Szükséges környezeti változók:
```bash
export SUPABASE_URL=https://daelyokkshcgtbijcfbz.supabase.co
export SUPABASE_SERVICE_KEY=eyJ...
```
