# Fusarium kockázati térkép — üzemeltetési átadás (Docker)

Ez a mappa a térkép **saját szerveren futtatható** változata. A jelenlegi éles
megoldás (Vercel + Supabase + GitHub Actions) ettől változatlanul tovább működik;
a két út párhuzamosan is használható.

```
Böngésző ──► web (nginx: React build + /api proxy) ──► api (FastAPI) ──► db (PostgreSQL 17)
                                                                           ▲
                         worker (napi ütemező: ODP → Open-Meteo, számítás) ┘
             [opcionális] caddy (HTTPS, Let's Encrypt) ──► web
```

| Szolgáltatás | Feladat | Megjegyzés |
|---|---|---|
| `db` | PostgreSQL 17, a 3 fuzárium tábla + függvények + nézetek | első induláskor `db/init/*.sql` létrehozza a sémát és a 30 állomást; kifelé nincs port |
| `api` | `GET /api/fusarium-api?action=dates\|risk\|stations`, `GET /api/health` | ugyanaz a JSON-forma, mint a Supabase Edge Functioné |
| `worker` | naponta `DAILY_HOUR`-kor (Europe/Budapest) pótolja a hiányzó szezonnapokat, és újraszámolja az utolsó `REFRESH_DAYS` napot | induláskor is fut egyet, így egy leállás után magától pótol |
| `web` | a React alkalmazás buildje, nginx | `WEB_PORT` (alapból 8080) |
| `caddy` | automatikus HTTPS | csak a `https` profillal indul |

Szezon: április 1. – október 31. Szezonon kívül a worker nem tölt le adatot.
Modellek: Mesterházy Á. et al. (1999) *Plant Breeding* 118:97–110;
Gyimes E. et al. (2012) *Növényvédelem* 48(8):347–352.

---

## 1. VM-követelmények

- **OS:** Ubuntu Server 24.04 LTS (vagy bármely Linux Dockerrel)
- **Erőforrás:** 2 vCPU, 4 GB RAM, 40 GB SSD (az adatbázis szezononként kb. 0,5 GB-tal nő)
- **Szoftver:** Docker Engine + Docker Compose plugin, git
- **Hálózat:**
  - bejövő: 80 és 443 (HTTPS-hez), vagy csak a `WEB_PORT` (belső hálózaton)
  - kimenő HTTPS: `odp.met.hu`, `archive-api.open-meteo.com`, `api.open-meteo.com`,
    a build idejére `registry-1.docker.io`, `registry.npmjs.org`, `pypi.org`
  - a böngészők közvetlenül az `api.open-meteo.com`-ot is hívják (3 napos előrejelzés)
- Ha a szerver magyar IP-ről fut, a HungaroMet ODP 403-as tiltása valószínűleg megszűnik,
  és a worker mért ODP adatot fog használni (az Open-Meteo marad a tartalék).

Docker telepítése Ubuntun:
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # utána ki- és bejelentkezés
```

## 2. Telepítés

```bash
sudo mkdir -p /opt && cd /opt
git clone https://github.com/adamthun/fusarium-map.git
cd fusarium-map/deploy
cp .env.example .env
nano .env                        # POSTGRES_PASSWORD kötelező (openssl rand -hex 24)
docker compose up -d --build
```

Ellenőrzés:
```bash
docker compose ps
curl http://localhost:8080/api/health
docker compose logs -f worker
```
A térkép: `http://SZERVER:8080`.

**HTTPS saját domainnel:** a domain DNS A-rekordja mutasson a VM IP-jére, a `.env`-ben
`DOMAIN=...`, majd:
```bash
docker compose --profile https up -d --build
```

## 3. Adatok áthozása a Supabase-ből (egyszeri)

> ⚠️ A Supabase projektet más alkalmazások is használják. **Nem teljes dump készül**,
> hanem kizárólag a három fuzárium tábla adatai: `public.stations`, `public.hourly_obs`,
> `public.fusarium_risk`. A script csak olvas, a Supabase-ben semmit nem módosít, és
> ellenőrzi, hogy más tábla nem került-e az exportba.

1. Supabase Dashboard → a projekt → **Connect** → *Session pooler* connection string
   (a jelszót a Database settings oldalon lehet megnézni vagy újragenerálni).
2. Export (bármely gépen, ahol van Docker, akár az új szerveren):
   ```bash
   cd /opt/fusarium-map/deploy
   SUPABASE_DB_URL='postgresql://postgres.<ref>:<jelszo>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres' \
     ./scripts/export_fusarium_from_supabase.sh
   ```
   Eredmény: `backups/fusarium_export_ÉÉÉÉHHNN.sql.gz`
3. Import az új szerveren (a stack fut):
   ```bash
   ./scripts/import_fusarium.sh backups/fusarium_export_ÉÉÉÉHHNN.sql.gz
   ```
   Az import közben a worker szünetel, utána újraindul, és pótolja az export óta eltelt napokat.

**Egyszerűbb út, export nélkül (javasolt):** az éles adatbázis 2026-11-22-i állapota
szerint az összes órás adat Open-Meteo ERA5 forrású (`source = 'OpenMeteo-ERA5'`, kb. 404 ezer
sor), ODP mérés nincs benne. Így a teljes állomány újra előállítható az új szerveren,
Supabase-jelszó és export nélkül (kb. 5–10 perc):
```bash
docker compose exec worker python jobs.py backfill --years 2024 2025 2026
docker compose exec worker python jobs.py status
```
A 30 állomás pontos éles adatai már a `db/init/02_seed_stations.sql`-ben vannak.

## 4. Üzemeltetés

| Feladat | Parancs |
|---|---|
| Állapot | `docker compose exec worker python jobs.py status` |
| Napi futás kézzel | `docker compose exec worker python jobs.py daily` |
| Időszak újraszámolása | `docker compose exec worker python jobs.py calc --start 2026-05-01 --end 2026-05-31` |
| Szezon újratöltése | `docker compose exec worker python jobs.py backfill --years 2026` |
| Naplók | `docker compose logs -f worker` / `api` / `web` |
| SQL konzol | `docker compose exec db psql -U fusarium` |
| Frissítés új verzióra | `git pull && docker compose up -d --build` |

**Mentés** — napi cron a hoszton (`crontab -e`):
```
0 3 * * * /opt/fusarium-map/deploy/scripts/backup.sh >> /var/log/fusarium-backup.log 2>&1
```
14 napig őrzi a `backups/` mappában (`KEEP_DAYS`). Érdemes a mappát a szerveren kívülre
is szinkronizálni. Visszaállítás: `./scripts/restore.sh backups/fusarium_....dump`.

## 5. Hibaelhárítás

- **Nincs friss nap a térképen:** `docker compose logs worker` — ha az ODP 403-at ad, a worker
  automatikusan Open-Meteóra vált. Ha egyik sem érhető el, a kimenő tűzfalat kell ellenőrizni.
- **A legutóbbi napok értéke módosul:** ez várt viselkedés. Az utolsó kb. 5 nap Open-Meteo
  forecast-adatból (`source = 'OpenMeteo-FC'`) jön, ezt az ERA5, illetve az ODP később felülírja.
  Mért ODP adatot modelladat soha nem ír felül.
- **Üres térkép, `/api/health` hibát ad:** `docker compose ps`; a `db` legyen `healthy`.
- **A séma változott:** a `db/init` csak üres adatkönyvtárnál fut le. Meglévő adatbázison a
  módosítást kézzel kell lefuttatni: `docker compose exec -T db psql -U fusarium < fajl.sql`.

## 6. Átadási ellenőrzőlista

- [ ] VM létrehozva, Docker telepítve, a kimenő hostok engedélyezve
- [ ] `.env` kitöltve, erős `POSTGRES_PASSWORD` (a `.env` nem kerül gitbe)
- [ ] `docker compose up -d --build` lefutott, a `/api/health` választ ad
- [ ] adatok importálva (3. pont), vagy backfill lefuttatva
- [ ] HTTPS/domain beállítva (ha kell)
- [ ] napi mentés cronban, külső másolat
- [ ] a worker napló első napi futása rendben (`DAILY_HOUR` után)
- [ ] átállás után a régi útvonal leállítása: a GitHub Actions workflow letiltása, a Vercel
      projekt átirányítása vagy leállítása. **A Supabase projektet nem szabad törölni**, mert
      más alkalmazások is használják; legfeljebb a 3 fuzárium tábla és a `fusarium-api`
      Edge Function távolítható el, ha már nincs rájuk szükség.
- [ ] titkok rotálása: a régi GitHub PAT és a Supabase service key visszavonható, ha az új
      szerver önállóan fut

## Fájlok

```
deploy/
├── docker-compose.yml
├── .env.example
├── db/init/01_schema.sql          séma, compute_daily_risk_range(), nézetek
├── db/init/02_seed_stations.sql   30 állomás
├── api/                           FastAPI (Edge Function megfelelője)
├── worker/jobs.py                 letöltés + számítás (daily | backfill | calc | status)
├── worker/scheduler.py            napi ütemező
├── web/Dockerfile, nginx.conf     React build + nginx
├── caddy/Caddyfile                HTTPS
└── scripts/                       export (csak fuzárium táblák), import, backup, restore
```
A frontend egyetlen ponton tér el a Vercel-es változattól: a `REACT_APP_API_URL`
build-változó az API-t a saját szerverre irányítja (`/api/fusarium-api`). Ha nincs
megadva (Vercel), marad a Supabase Edge Function.
