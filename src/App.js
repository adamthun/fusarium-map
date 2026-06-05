import { useState, useEffect, useRef, useCallback } from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";

// ══════════════════════════════════════════════════════════════
// FUSARIUM FERTŐZÉSI KOCKÁZAT BECSLŐ — v2
// Modell: Mesterházy Á., Bartók T., Mirocha C.G., Komoroczy R.
//   Plant Breeding 118: 97–110. (1999)
//   DOI: 10.1046/j.1439-0523.1999.118001097.x
// Magyar adaptáció: Gyimes E. et al. Növényvédelem 48(8) (2012)
// Adatforrás: HungaroMet ODP
//   https://odp.met.hu/weather/weather_reports/synoptic/hungary/hourly/
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL  = process.env.REACT_APP_SUPABASE_URL  || "https://daelyokkshcgtbijcfbz.supabase.co";
const SUPABASE_ANON = process.env.REACT_APP_SUPABASE_ANON_KEY || "";
const EDGE_FN       = `${SUPABASE_URL}/functions/v1/fusarium-api`;

const STATIONS = [
  {id:44309,nm:"Szeged",             lat:46.2561,lon:20.0900,county:"Csongrád-Csanád",   r:"alfold",  w:true},
  {id:44206,nm:"Kecskemét",          lat:46.9167,lon:19.7500,county:"Bács-Kiskun",        r:"alfold",  w:true},
  {id:54201,nm:"Szolnok",            lat:47.1667,lon:20.1833,county:"Jász-NK-Sz",         r:"alfold",  w:true},
  {id:54713,nm:"Orosháza",           lat:46.5667,lon:20.6667,county:"Békés",              r:"alfold",  w:true},
  {id:63510,nm:"Debrecen",           lat:47.4900,lon:21.6153,county:"Hajdú-Bihar",        r:"alfold",  w:true},
  {id:64100,nm:"Nyíregyháza",        lat:47.9500,lon:21.7167,county:"Szabolcs-Sz-B",      r:"alfold",  w:true},
  {id:64716,nm:"Túrkeve",            lat:47.1000,lon:20.7500,county:"Jász-NK-Sz",         r:"alfold",  w:true},
  {id:43609,nm:"Baja",               lat:46.1947,lon:18.9583,county:"Bács-Kiskun",        r:"alfold",  w:true},
  {id:42409,nm:"Paks",               lat:46.6167,lon:18.8567,county:"Tolna",              r:"alfold",  w:true},
  {id:35418,nm:"Martonvásár",        lat:47.3111,lon:18.7800,county:"Fejér",              r:"dunantul",w:true, ref:true},
  {id:35315,nm:"Agárd",              lat:47.1900,lon:18.5836,county:"Fejér",              r:"dunantul",w:true},
  {id:36306,nm:"Siófok",             lat:46.9033,lon:18.0478,county:"Somogy",             r:"dunantul",w:true},
  {id:27815,nm:"Kaposvár",           lat:46.3628,lon:17.8739,county:"Somogy",             r:"dunantul",w:true},
  {id:37404,nm:"Pécs",               lat:46.0022,lon:18.2272,county:"Baranya",            r:"dunantul",w:true},
  {id:37713,nm:"Mohács",             lat:45.9833,lon:18.6833,county:"Baranya",            r:"dunantul",w:true},
  {id:29403,nm:"Sellye",             lat:45.8675,lon:17.8511,county:"Baranya",            r:"dunantul",w:true},
  {id:36605,nm:"Dombóvár",           lat:46.3792,lon:18.1333,county:"Tolna",              r:"dunantul",w:true},
  {id:23703,nm:"Győr",               lat:47.7100,lon:17.6747,county:"Győr-M-S",           r:"dunantul",w:true},
  {id:23201,nm:"Mosonmagyaróvár",    lat:47.8897,lon:17.2672,county:"Győr-M-S",           r:"dunantul",w:true},
  {id:15310,nm:"Szombathely",        lat:47.1983,lon:16.6478,county:"Vas",                r:"dunantul",w:false},
  {id:26505,nm:"Keszthely",          lat:46.7356,lon:17.2386,county:"Zala",               r:"dunantul",w:false},
  {id:34712,nm:"Felcsút",            lat:47.4494,lon:18.5775,county:"Fejér",              r:"dunantul",w:true},
  {id:13704,nm:"Sopron",             lat:47.6783,lon:16.6022,county:"Győr-M-S",           r:"dunantul",w:false},
  {id:24607,nm:"Pápa",               lat:47.3706,lon:17.4964,county:"Veszprém",           r:"dunantul",w:true},
  {id:25820,nm:"Szentkirályszabadja",lat:47.0828,lon:17.9706,county:"Veszprém",           r:"dunantul",w:false},
  {id:34233,nm:"Tatabánya",          lat:47.5889,lon:18.3853,county:"Komárom-E",          r:"dunantul",w:true},
  {id:53509,nm:"Eger",               lat:47.8983,lon:20.3753,county:"Heves",              r:"eszak",   w:true},
  {id:53411,nm:"Miskolc",            lat:48.1000,lon:20.7833,county:"Borsod-A-Z",         r:"eszak",   w:true},
  {id:43113,nm:"Budapest",           lat:47.4314,lon:19.1822,county:"Pest",               r:"eszak",   w:true},
  {id:32805,nm:"Tésa",               lat:48.0269,lon:18.8256,county:"Pest",               r:"eszak",   w:false},
];

// ── OpenMeteo API: 4 napos óránkénti előrejelzés egy állomásra ──
// Forrás: open-meteo.com — CC BY 4.0, kulcs nélküli
async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: "temperature_2m,relativehumidity_2m,precipitation_probability",
    forecast_days: 4,
    timezone: "Europe/Budapest",
    wind_speed_unit: "ms",
  });
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!r.ok) throw new Error("OpenMeteo hiba");
  return r.json();
}

// TRH9010 számítás óránkénti tömbből (7 napos ablak = 168 óra)
function calcTRH9010fromHours(temps, rhs) {
  let consec = 0, maxConsec = 0;
  for (let i = 0; i < temps.length; i++) {
    if (rhs[i] > 90 && temps[i] >= 15 && temps[i] <= 30) {
      consec++;
      maxConsec = Math.max(maxConsec, consec);
    } else consec = 0;
  }
  const p = -3.3756 + 6.8128 * maxConsec;
  return { trh: maxConsec, p: Math.max(0, Math.min(100, p)) };
}

// Optimista/pesszimista változat csapadékvalószínűség alapján
// Ha magas a csapadékvalószínűség → magasabb RH várható → pesszimista
function calcForecastBand(temps, rhs, precipProbs) {
  // Pesszimista: ahol csapadék >40%, ott RH-t +5%-kal növeljük
  const rhPess = rhs.map((rh, i) => precipProbs[i] > 40 ? Math.min(100, rh + 8) : rh);
  // Optimista: ahol csapadék <30%, ott RH-t -5%-kal csökkentjük  
  const rhOpt  = rhs.map((rh, i) => precipProbs[i] < 30 ? Math.max(0, rh - 8) : rh);
  const base = calcTRH9010fromHours(temps, rhs);
  const pess = calcTRH9010fromHours(temps, rhPess);
  const opt  = calcTRH9010fromHours(temps, rhOpt);
  return { p: base.p, pMin: opt.p, pMax: pess.p, trh: base.trh };
}

async function apiFetch(params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${EDGE_FN}?${qs}`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` }
  });
  if (!r.ok) throw new Error(`API ${r.status}`);
  return r.json();
}

function demoData(date, model) {
  const h = s => { let x=0; for(let c of s) x=Math.imul(31,x)+c.charCodeAt(0); return x>>>0; };
  return STATIONS.map(s => {
    const base = s.lon < 18 ? 45 : s.lon < 20 ? 22 : 12;
    const noise = (h(String(s.id)+date) % 1000)/1000*55 - 10;
    const p = Math.max(0, Math.min(100, base+noise+(model===2?8:0)));
    return { ...s, p:+p.toFixed(1),
      th: model===1 ? Math.round(p/6.8) : null,
      iv: model===2 ? +(p/10.5).toFixed(2) : null };
  }).sort((a,b)=>b.p-a.p);
}

function rc(p) {
  if (p<=0)  return "#16a34a";
  if (p<=10) return "#22c55e";
  if (p<=25) return "#a3e635";
  if (p<=40) return "#eab308";
  if (p<=60) return "#f97316";
  if (p<=80) return "#ef4444";
  return "#991b1b";
}
function rcLeaflet(p) {
  if (p<=0)  return {color:"#16a34a",fill:"#16a34a"};
  if (p<=10) return {color:"#22c55e",fill:"#22c55e"};
  if (p<=25) return {color:"#84cc16",fill:"#84cc16"};
  if (p<=40) return {color:"#eab308",fill:"#eab308"};
  if (p<=60) return {color:"#f97316",fill:"#f97316"};
  if (p<=80) return {color:"#ef4444",fill:"#ef4444"};
  return {color:"#991b1b",fill:"#7f1d1d"};
}
function rl(p) {
  if (p<=0)  return "Nincs";
  if (p<=10) return "Alacsony";
  if (p<=25) return "Mérsékelt";
  if (p<=40) return "Közepes";
  if (p<=60) return "Magas";
  if (p<=80) return "Veszélyes";
  return "Kritikus";
}
function re(p) {
  if (p<=10) return "🟢";
  if (p<=25) return "🟡";
  if (p<=40) return "🟠";
  if (p<=60) return "🔴";
  return "⛔";
}


// Alaptérkép típus váltó komponens
function TileLayerSwitcher({ mapStyle }) {
  const map = useMap();
  useEffect(() => { map.invalidateSize(); }, [map, mapStyle]);
  
  const tiles = {
    osm: { url:"https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", attr:"© OpenStreetMap" },
    satellite: { url:"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", attr:"© Esri" },
    topo: { url:"https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", attr:"© OpenTopoMap" },
    dark: { url:"https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png", attr:"© Stadia Maps" },
  };
  const t = tiles[mapStyle] || tiles.osm;
  return <TileLayer url={t.url} attribution={t.attr} />;
}

export default function App() {
  const today = new Date().toISOString().split("T")[0];
  const [date, setDate]       = useState(today);
  const [model, setModel]     = useState(1);
  const [data, setData]       = useState([]);
  const [dates, setDates]     = useState([today]);
  const [loading, setLoading] = useState(true);
  const [src, setSrc]         = useState("loading");
  const [lastUp, setLastUp]   = useState(null);
  const [tab, setTab]         = useState("map");
  const [region, setRegion]   = useState("all");
  const [mapStyle, setMapStyle] = useState("osm");
  const [showHeat, setShowHeat] = useState(true);
  const [forecast, setForecast] = useState({}); // {date: [{station_id, p, pMin, pMax}]}
  const [forecastDates, setForecastDates] = useState([]); // jövő dátumok
  const [isForecast, setIsForecast] = useState(false);
  const [selYear, setSelYear] = useState(new Date().getFullYear());
  const [selMonth, setSelMonth] = useState(new Date().getMonth()); // 0-indexed

  // Elérhető múltbeli dátumok
  useEffect(() => {
    apiFetch({ action:"dates" })
      .then(r => { if (r.dates?.length) { setDates(r.dates); setDate(r.dates[0]); } })
      .catch(() => {});
  }, []);

  // OpenMeteo előrejelzés betöltése az összes állomásra
  useEffect(() => {
    const today = new Date();
    const futureDates = [1,2,3].map(i => {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      return d.toISOString().split("T")[0];
    });
    setForecastDates(futureDates);

    // Párhuzamos lekérdezés az összes állomásra
    // Throttolva, hogy ne terhelje az API-t
    const results = {};
    futureDates.forEach(d => { results[d] = []; });

    let idx = 0;
    const batchSize = 5;
    
    async function fetchBatch() {
      const batch = STATIONS.slice(idx, idx + batchSize);
      if (batch.length === 0) {
        setForecast({...results});
        return;
      }
      idx += batchSize;

      await Promise.allSettled(batch.map(async (s) => {
        try {
          const d = await fetchForecast(s.lat, s.lon);
          const times = d.hourly.time;
          const temps = d.hourly.temperature_2m;
          const rhs   = d.hourly.relativehumidity_2m;
          const probs = d.hourly.precipitation_probability;

          futureDates.forEach((fdate, fi) => {
            // Az adott nap + előző 6 nap óráit vesszük (7 napos ablak)
            const dayStart = times.findIndex(t => t.startsWith(fdate));
            if (dayStart === -1) return;
            // Vegyük az összes elérhető előre jelzett órát (max 96h)
            const windowEnd = Math.min(dayStart + 24, times.length);
            const windowStart = Math.max(0, dayStart - (7 * 24 - 24));
            const wTemps = temps.slice(windowStart, windowEnd);
            const wRhs   = rhs.slice(windowStart, windowEnd);
            const wProbs = probs.slice(windowStart, windowEnd);

            const band = calcForecastBand(wTemps, wRhs, wProbs);
            results[fdate].push({ ...s, ...band });
          });
        } catch(e) {
          // Ha egy állomás nem tölt be, kihagyjuk
        }
      }));

      setTimeout(fetchBatch, 200); // 200ms között kötegek
    }
    fetchBatch();
  }, []);

  // Dátum váltáskor figyeljük meg, hogy előrejelzés-e
  useEffect(() => {
    setIsForecast(forecastDates.includes(date));
  }, [date, forecastDates]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch({ action:"risk", date, model:String(model) })
      .then(r => {
        if (cancelled) return;
        if (r.data?.length > 0) {
          const byId = Object.fromEntries(r.data.map(d => [d.station_id, d]));
          const merged = STATIONS.map(s => {
            const db = byId[s.id];
            if (!db) return null;
            return { ...s, p:+db.risk_pct,
              th:db.trh9010_hours?+db.trh9010_hours:null,
              iv:db.int3_value?+db.int3_value:null,
              obs_count:db.obs_count };
          }).filter(Boolean).sort((a,b)=>b.p-a.p);
          setData(merged.length > 0 ? merged : demoData(date, model));
          setSrc(merged.length > 0 ? "live" : "demo");
          setLastUp(r.data[0]?.calculated_at);
        } else {
          setData(demoData(date, model));
          setSrc("demo");
        }
      })
      .catch(() => {
        if (!cancelled) { setData(demoData(date, model)); setSrc("demo"); }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date, model]);

  // Ha előrejelzés napot nézünk, az OpenMeteo adatot használjuk
  const activeData = (isForecast && forecast[date]?.length > 0)
    ? forecast[date]
    : data;

  const filtered = region==="all" ? activeData : activeData.filter(s=>s.r===region);
  const maxR = activeData.length ? Math.max(...activeData.map(d=>d.p)) : 0;
  const avgR = activeData.length ? activeData.reduce((s,d)=>s+d.p,0)/activeData.length : 0;
  const hi   = activeData.filter(d=>d.p>=60).length;

  const bd  = "rgba(255,255,255,0.07)";
  const dim = "rgba(232,228,220,0.38)";
  const mid = "rgba(232,228,220,0.6)";

  return (
    <div style={{ fontFamily:"Georgia,serif", background:"#090d18", minHeight:"100vh", color:"#e8e4dc" }}>

      {/* HEADER */}
      <div style={{ padding:"12px 20px 8px", background:"linear-gradient(90deg,rgba(180,40,20,0.1),rgba(50,110,30,0.06))", borderBottom:`1px solid ${bd}` }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <img
          src="https://uni-mate.hu/o/mate-theme/images/mate_symbol_white.png"
          alt="MATE"
          style={{ height:38, width:"auto", flexShrink:0 }}
          onError={e => { e.target.style.display="none"; }}
        />
          <div>
            <div style={{ fontSize:18,fontWeight:700 }}>Fusarium Kockázati Térkép</div>
            <div style={{ fontSize:10,color:dim,letterSpacing:"0.08em",textTransform:"uppercase" }}>
              Magyarország · 30 OMSZ állomás · HungaroMet ODP

            </div>
          </div>
          {lastUp && (
            <div style={{ marginLeft:"auto",fontSize:10,color:dim,textAlign:"right" }}>
              Frissítve: <span style={{ fontFamily:"monospace" }}>{new Date(lastUp).toLocaleString("hu-HU")}</span>
            </div>
          )}
        </div>
      </div>

      {/* STATISZTIKA */}
      <div style={{ display:"flex",gap:1,borderBottom:`1px solid ${bd}` }}>
        {[
          {l:"Max kockázat",v:`${maxR.toFixed(0)}%`,c:rc(maxR)},
          {l:"Átlag",v:`${avgR.toFixed(1)}%`,c:rc(avgR)},
          {l:"Veszélyes (≥60%)",v:`${hi} db`,c:hi>0?"#ef4444":"#22c55e"},
          {l:"Állomások",v:`${data.length}/30`,c:"#6a7a8a"},
        ].map((c,i)=>(
          <div key={i} style={{ flex:1,padding:"6px 14px",borderRight:i<3?`1px solid ${bd}`:"none" }}>
            <div style={{ fontSize:8,textTransform:"uppercase",letterSpacing:"0.09em",color:dim,marginBottom:1 }}>{c.l}</div>
            <div style={{ fontSize:18,fontWeight:700,color:c.c,fontFamily:"monospace" }}>{c.v}</div>
          </div>
        ))}
      </div>

      {/* KONTROLLOK */}
      <div style={{ display:"flex",flexWrap:"wrap",gap:10,padding:"8px 20px",borderBottom:`1px solid ${bd}`,alignItems:"center",background:"rgba(255,255,255,0.01)" }}>
        {/* ── SZEZON NAPTÁR ── */}
        {(() => {
          const today = new Date().toISOString().split("T")[0];
          const currentYear = new Date().getFullYear();
          const years = [currentYear-2, currentYear-1, currentYear];
          const seasonMonths = [3,4,5,6,7,8,9]; // ápr–okt
          const monthNames = ["Jan","Feb","Már","Ápr","Máj","Jún","Júl","Aug","Sze","Okt","Nov","Dec"];

          // Az adott hónap napjainak listája
          const getDaysInMonth = (year, month) => {
            const days = [];
            const daysInMonth = new Date(year, month+1, 0).getDate();
            for (let d = 1; d <= daysInMonth; d++) {
              const ds = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
              days.push(ds);
            }
            return days;
          };

          const monthDays = getDaysInMonth(selYear, selMonth);
          const firstDow = new Date(selYear, selMonth, 1).getDay(); // 0=vasárnap
          const firstMon = firstDow === 0 ? 6 : firstDow - 1; // hétfőtől

          return (
            <div style={{ minWidth:260 }}>
              {/* Év választó */}
              <div style={{ display:"flex", gap:4, marginBottom:6, alignItems:"center" }}>
                <span style={{ fontSize:8, color:dim, textTransform:"uppercase", letterSpacing:"0.1em", marginRight:4 }}>Szezon</span>
                {years.map(y => (
                  <button key={y} onClick={() => { setSelYear(y); setSelMonth(4); }} style={{
                    padding:"2px 8px", borderRadius:4, cursor:"pointer", fontSize:11,
                    fontFamily:"monospace", fontWeight: selYear===y ? 700 : 400,
                    background: selYear===y ? "rgba(200,64,32,0.3)" : "rgba(255,255,255,0.05)",
                    color: selYear===y ? "#f0ece4" : dim,
                    border: `1px solid ${selYear===y ? "rgba(200,64,32,0.5)" : "rgba(255,255,255,0.08)"}`,
                  }}>{y}</button>
                ))}
              </div>

              {/* Hónap választó — csak ápr–okt */}
              <div style={{ display:"flex", gap:2, marginBottom:6 }}>
                {seasonMonths.map(m => {
                  const hasDates = dates.some(d => d.startsWith(`${selYear}-${String(m+1).padStart(2,"0")}`));
                  const hasForecast = forecastDates.some(d => d.startsWith(`${selYear}-${String(m+1).padStart(2,"0")}`));
                  const isSelected = selMonth === m;
                  return (
                    <button key={m} onClick={() => setSelMonth(m)} style={{
                      padding:"2px 6px", borderRadius:4, cursor:"pointer", fontSize:10,
                      fontWeight: isSelected ? 700 : 400,
                      background: isSelected ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.04)",
                      color: isSelected ? "#f0ece4" : hasDates ? dim : "rgba(255,255,255,0.2)",
                      border: `1px solid ${isSelected ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.07)"}`,
                      position:"relative",
                    }}>
                      {monthNames[m]}
                      {(hasDates || hasForecast) && (
                        <span style={{
                          position:"absolute", top:1, right:1,
                          width:4, height:4, borderRadius:"50%",
                          background: hasForecast ? "#fbbf24" : "#4a8c2b",
                        }}/>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Nap nézet — heti rács */}
              <div>
                {/* Fejléc */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:1, marginBottom:2 }}>
                  {["H","K","Sz","Cs","P","Szo","V"].map(d => (
                    <div key={d} style={{ textAlign:"center", fontSize:8, color:"rgba(255,255,255,0.25)" }}>{d}</div>
                  ))}
                </div>
                {/* Napok */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:1 }}>
                  {/* Üres cellák a hónap eleje előtt */}
                  {Array(firstMon).fill(null).map((_,i) => (
                    <div key={`empty-${i}`}/>
                  ))}
                  {monthDays.map(d => {
                    const hasData = dates.includes(d);
                    const isFcast = forecastDates.includes(d);
                    const isSelected = date === d;
                    const isFuture = d > today;
                    const dayNum = parseInt(d.slice(8));
                    return (
                      <button key={d}
                        onClick={() => (hasData || isFcast) && setDate(d)}
                        disabled={!hasData && !isFcast}
                        style={{
                          padding:"3px 0", borderRadius:3, cursor: (hasData||isFcast) ? "pointer" : "default",
                          fontSize:9, textAlign:"center", fontFamily:"monospace",
                          background: isSelected
                            ? (isFcast ? "rgba(251,191,36,0.35)" : "rgba(200,64,32,0.4)")
                            : hasData ? "rgba(74,140,43,0.15)"
                            : isFcast ? "rgba(251,191,36,0.08)"
                            : "transparent",
                          color: isSelected ? "#f0ece4"
                            : hasData ? "#a0d070"
                            : isFcast ? "rgba(251,191,36,0.7)"
                            : "rgba(255,255,255,0.15)",
                          border: `1px solid ${isSelected
                            ? (isFcast ? "rgba(251,191,36,0.6)" : "rgba(200,64,32,0.6)")
                            : hasData ? "rgba(74,140,43,0.3)"
                            : isFcast ? "rgba(251,191,36,0.2)"
                            : "transparent"}`,
                          fontWeight: isSelected ? 700 : 400,
                        }}>
                        {dayNum}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Jelmagyarázat */}
              <div style={{ display:"flex", gap:10, marginTop:5, fontSize:8, color:dim }}>
                <span><span style={{ display:"inline-block",width:6,height:6,borderRadius:"50%",background:"#4a8c2b",marginRight:2 }}/>Mért</span>
                <span><span style={{ display:"inline-block",width:6,height:6,borderRadius:"50%",background:"#fbbf24",marginRight:2 }}/>Előrejelzés</span>
                <span style={{ marginLeft:"auto", fontFamily:"monospace", color: isForecast ? "#fbbf24" : "#a0d070", fontWeight:600 }}>{date}</span>
              </div>
            </div>
          );
        })()}