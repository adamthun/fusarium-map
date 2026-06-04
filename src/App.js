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
        {dates.length > 0 && (
          <div style={{ flex:1, minWidth:320 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
              <div style={{ fontSize:8,color:dim,textTransform:"uppercase",letterSpacing:"0.1em" }}>Dátum</div>
              <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                {isForecast && (
                  <span style={{ fontSize:9, color:"#fbbf24", background:"rgba(251,191,36,0.1)", border:"1px solid rgba(251,191,36,0.3)", borderRadius:4, padding:"1px 6px" }}>
                    📡 Előrejelzés
                  </span>
                )}
                <span style={{ fontSize:12, fontFamily:"monospace", color: isForecast ? "#fbbf24" : "#e8e4dc", fontWeight:600 }}>
                  {date}
                </span>
              </div>
            </div>
            {/* Összevont csúszka: múlt + előrejelzés */}
            {(() => {
              const allDates = [...dates].reverse().concat(forecastDates);
              const curIdx = allDates.indexOf(date);
              const histCount = dates.length;
              return (
                <div>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ fontSize:9, color:dim, whiteSpace:"nowrap" }}>{allDates[0]}</span>
                    <div style={{ flex:1, position:"relative" }}>
                      {/* Háttér: múlt vs jövő */}
                      <div style={{ position:"absolute", top:"50%", left:0, right:0, height:4, transform:"translateY(-50%)", borderRadius:2, overflow:"hidden", display:"flex" }}>
                        <div style={{ flex:histCount, background:"rgba(200,64,32,0.35)" }}/>
                        <div style={{ width:2, background:"rgba(255,255,255,0.4)" }}/>
                        <div style={{ flex:forecastDates.length, background:"rgba(251,191,36,0.25)" }}/>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={allDates.length - 1}
                        value={Math.max(0, curIdx)}
                        onChange={e => setDate(allDates[parseInt(e.target.value)])}
                        style={{ width:"100%", accentColor: isForecast ? "#fbbf24" : "#c84020", cursor:"pointer", position:"relative", zIndex:1, background:"transparent" }}
                      />
                    </div>
                    <span style={{ fontSize:9, color:"#fbbf24", whiteSpace:"nowrap" }}>+3 nap</span>
                  </div>
                  {/* Felirat sor */}
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:8, color:dim, marginTop:2, paddingLeft:2, paddingRight:2 }}>
                    <span>← Múlt ({dates.length} nap)</span>
                    <span style={{ color:"rgba(255,255,255,0.25)" }}>│ Ma │</span>
                    <span style={{ color:"rgba(251,191,36,0.6)" }}>Előrejelzés →</span>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
        <div>
          <div style={{ fontSize:8,color:dim,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:3 }}>Modell</div>
          <div style={{ display:"flex" }}>
            {[{id:1,l:"① TRH9010"},{id:2,l:"② INT3"}].map(m=>(
              <button key={m.id} onClick={()=>setModel(m.id)} style={{
                padding:"5px 10px",fontSize:11,fontFamily:"inherit",cursor:"pointer",
                background:model===m.id?"rgba(180,40,20,0.3)":"rgba(255,255,255,0.04)",
                color:model===m.id?"#e8e4dc":mid,
                border:`1px solid ${model===m.id?"rgba(180,40,20,0.5)":bd}`,
                borderRadius:m.id===1?"5px 0 0 5px":"0 5px 5px 0",
                fontWeight:model===m.id?700:400,
              }}>{m.l}</button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize:8,color:dim,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:3 }}>Régió</div>
          <select value={region} onChange={e=>setRegion(e.target.value)}
            style={{ background:"rgba(255,255,255,0.05)",border:`1px solid ${bd}`,borderRadius:5,padding:"5px 8px",color:"#e8e4dc",fontSize:12,fontFamily:"monospace" }}>
            <option value="all" style={{background:"#0d1525"}}>Összes</option>
            <option value="alfold" style={{background:"#0d1525"}}>Nagyalföld</option>
            <option value="dunantul" style={{background:"#0d1525"}}>Dunántúl</option>
            <option value="eszak" style={{background:"#0d1525"}}>Észak-Mo.</option>
          </select>
        </div>
        {tab==="map" && <>
          <div>
            <div style={{ fontSize:8,color:dim,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:3 }}>Alaptérkép</div>
            <div style={{ display:"flex" }}>
              {[{k:"osm",l:"Térkép"},{k:"satellite",l:"Műhold"},{k:"topo",l:"Domb."}].map(s=>(
                <button key={s.k} onClick={()=>setMapStyle(s.k)} style={{
                  padding:"5px 8px",fontSize:10,fontFamily:"inherit",cursor:"pointer",
                  background:mapStyle===s.k?"rgba(50,110,180,0.35)":"rgba(255,255,255,0.04)",
                  color:mapStyle===s.k?"#90c0ff":mid,
                  border:`1px solid ${mapStyle===s.k?"rgba(50,110,180,0.5)":bd}`,
                  borderRadius:"0",
                  fontWeight:mapStyle===s.k?700:400,
                }}>{s.l}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize:8,color:dim,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:3 }}>Hőtérkép</div>
            <button onClick={()=>setShowHeat(!showHeat)} style={{
              padding:"5px 10px",fontSize:11,fontFamily:"inherit",cursor:"pointer",
              background:showHeat?"rgba(200,120,20,0.3)":"rgba(255,255,255,0.04)",
              color:showHeat?"#fbbf24":mid, border:`1px solid ${showHeat?"rgba(200,120,20,0.5)":bd}`,
              borderRadius:5,
            }}>{showHeat?"🌡 Be":"🌡 Ki"}</button>
          </div>
        </>}
        <div style={{ marginLeft:"auto",display:"flex",gap:4 }}>
          {[{k:"map",l:"🗺 Térkép"},{k:"table",l:"📋 Táblázat"},{k:"info",l:"ℹ Módszertan"}].map(t=>(
            <button key={t.k} onClick={()=>setTab(t.k)} style={{
              padding:"5px 10px",fontSize:10,fontFamily:"inherit",cursor:"pointer",
              background:tab===t.k?"rgba(50,110,30,0.25)":"rgba(255,255,255,0.04)",
              color:tab===t.k?"#a0e060":mid,
              border:`1px solid ${tab===t.k?"rgba(50,110,30,0.4)":bd}`,borderRadius:5,
            }}>{t.l}</button>
          ))}
        </div>
      </div>

      {/* LEAFLET TÉRKÉP */}
      {tab==="map" && (
        <div style={{ padding:"10px 20px 4px" }}>
          <div style={{ borderRadius:8,overflow:"hidden",border:`1px solid ${bd}`,position:"relative" }}>

            {isForecast && (
              <div style={{ position:"absolute",top:10,left:"50%",transform:"translateX(-50%)",
                zIndex:1000, background:"rgba(251,191,36,0.12)",
                border:"1px solid rgba(251,191,36,0.4)", borderRadius:6,
                padding:"5px 14px", fontSize:11, color:"#fbbf24",
                fontWeight:600, whiteSpace:"nowrap", backdropFilter:"blur(4px)" }}>
                📡 Előrejelzés — OpenMeteo alapján, bizonytalansági sávval
              </div>
            )}
            <MapContainer
              center={[47.16, 19.5]}
              zoom={7}
              style={{ height:"calc(100vh - 220px)", minHeight:"420px", width:"100%" }}
              zoomControl={true}
            >
              <TileLayerSwitcher mapStyle={mapStyle} />

              {/* Hőtérkép körök (nagy, átlátszó) */}
              {showHeat && filtered.map(s => {
                const colors = rcLeaflet(s.p);
                return (
                  <CircleMarker
                    key={`heat-${s.id}`}
                    center={[s.lat, s.lon]}
                    radius={Math.max(25, 20 + s.p * 0.5)}
                    pathOptions={{
                      color: colors.color,
                      fillColor: colors.fill,
                      fillOpacity: 0.18,
                      weight: 0,
                    }}
                  />
                );
              })}

              {/* Állomás pontok */}
              {filtered.map(s => {
                const colors = rcLeaflet(s.p);
                const faded = region !== "all" && s.r !== region;
                return (
                  <CircleMarker
                    key={`st-${s.id}`}
                    center={[s.lat, s.lon]}
                    radius={s.ref ? 10 : 8}
                    pathOptions={{
                      color: s.ref ? "#fbbf24" : "rgba(255,255,255,0.8)",
                      fillColor: colors.fill,
                      fillOpacity: faded ? 0.3 : 0.9,
                      weight: s.ref ? 2.5 : 1.5,
                    }}
                  >
                    <Tooltip direction="top" offset={[0, -10]} opacity={0.97}>
                      <div style={{ fontFamily:"sans-serif", fontSize:12, minWidth:150, maxWidth:210 }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:3 }}>
                          <strong style={{ fontSize:13 }}>{s.nm}</strong>
                          <span style={{ fontWeight:800, color:colors.color, fontSize:14, marginLeft:8 }}>{s.p.toFixed(0)}%</span>
                        </div>
                        <div style={{ color:"#555", fontSize:10, marginBottom:3 }}>{s.county}</div>
                        <div style={{ color:colors.color, fontWeight:600, fontSize:11 }}>{re(s.p)} {rl(s.p)}</div>

                        {isForecast && s.pMin != null && s.pMax != null && (
                          <div style={{ marginTop:5, paddingTop:5, borderTop:"1px solid #eee" }}>
                            <div style={{ fontSize:9, color:"#888", marginBottom:2 }}>Bizonytalansági sáv:</div>
                            <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                              <span style={{ fontSize:9, color:"#22c55e" }}>{s.pMin.toFixed(0)}%</span>
                              <div style={{ flex:1, height:4, borderRadius:2, background:"#e5e7eb", position:"relative", overflow:"hidden" }}>
                                <div style={{ position:"absolute", left:`${s.pMin}%`, width:`${Math.max(2,s.pMax-s.pMin)}%`, height:"100%", background:colors.color, opacity:0.5 }}/>
                                <div style={{ position:"absolute", left:`${Math.min(98,s.p)}%`, width:2, height:"100%", background:colors.color }}/>
                              </div>
                              <span style={{ fontSize:9, color:"#ef4444" }}>{s.pMax.toFixed(0)}%</span>
                            </div>
                            <div style={{ fontSize:8, color:"#aaa", marginTop:2 }}>📡 OpenMeteo ECMWF modell</div>
                          </div>
                        )}
                        {!isForecast && model===1 && s.th!=null && <div style={{ fontSize:9, color:"#888", marginTop:2, fontFamily:"monospace" }}>TRH9010 = {s.th} h</div>}
                        {!isForecast && model===2 && s.iv!=null && <div style={{ fontSize:9, color:"#888", marginTop:2, fontFamily:"monospace" }}>INT3 = {s.iv}</div>}
                        {s.ref && <div style={{ fontSize:9, color:"#b45309", marginTop:2 }}>★ MTA ATK referencia</div>}
                      </div>
                    </Tooltip>
                  </CircleMarker>
                );
              })}
            </MapContainer>

            {/* Jelmagyarázat a térkép felett */}
            <div style={{ position:"absolute",bottom:28,left:10,zIndex:1000,
              background:"rgba(9,13,24,0.88)",borderRadius:6,padding:"6px 10px",
              border:`1px solid ${bd}`,display:"flex",gap:4,alignItems:"center" }}>
              <span style={{ fontSize:8,color:dim,marginRight:4,textTransform:"uppercase",letterSpacing:"0.08em" }}>Kockázat</span>
              {[0,10,25,40,60,80,100].map(v=>(
                <div key={v} style={{ display:"flex",alignItems:"center",gap:2 }}>
                  <div style={{ width:14,height:6,borderRadius:1,background:rc(v) }}/>
                  <span style={{ fontSize:7,color:dim }}>{v}%</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ fontSize:9,color:dim,padding:"4px 4px",textAlign:"right" }}>
            Alaptérkép: {mapStyle==="satellite"?"© Esri World Imagery":mapStyle==="topo"?"© OpenTopoMap":mapStyle==="dark"?"© Stadia Maps":"© OpenStreetMap contributors"} · Kockázati adatok: HungaroMet ODP
          </div>
        </div>
      )}

      {/* TÁBLÁZAT */}
      {tab==="table" && (
        <div style={{ padding:"10px 20px 14px" }}>
          <div style={{ background:"rgba(255,255,255,0.02)",borderRadius:8,border:`1px solid ${bd}`,overflow:"hidden" }}>
            <div style={{ padding:"7px 12px",borderBottom:`1px solid ${bd}`,fontSize:10,fontWeight:600,color:mid,display:"flex",justifyContent:"space-between" }}>
              <span>Állomásonkénti kockázat — {date}</span>
              <span style={{ fontFamily:"monospace",fontSize:9 }}>Modell {model} · {filtered.length} db</span>
            </div>
            <div style={{ maxHeight:450,overflow:"auto" }}>
              <table style={{ width:"100%",borderCollapse:"collapse",fontSize:11 }}>
                <thead>
                  <tr style={{ borderBottom:`1px solid ${bd}`,position:"sticky",top:0,background:"#0d1525" }}>
                    {["#","Állomás","Megye","Régió",model===1?"TRH9010(h)":"INT3","p%","Szint"].map(h=>(
                      <th key={h} style={{ padding:"5px 8px",textAlign:"left",color:dim,fontWeight:500,fontSize:8,textTransform:"uppercase" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s,i)=>(
                    <tr key={s.id} style={{ borderBottom:"1px solid rgba(255,255,255,0.025)",background:i%2?"transparent":"rgba(255,255,255,0.01)" }}>
                      <td style={{ padding:"4px 8px",color:dim,fontFamily:"monospace",fontSize:9 }}>{i+1}</td>
                      <td style={{ padding:"4px 8px",fontWeight:600 }}>{s.nm}{s.ref&&<span style={{ marginLeft:4,fontSize:8,color:"#fbbf24" }}>★</span>}</td>
                      <td style={{ padding:"4px 8px",color:mid,fontSize:10 }}>{s.county}</td>
                      <td style={{ padding:"4px 8px" }}>
                        <span style={{ fontSize:9,padding:"1px 5px",borderRadius:3,
                          background:s.r==="alfold"?"rgba(60,120,200,0.15)":s.r==="dunantul"?"rgba(120,80,30,0.2)":"rgba(80,60,120,0.2)",
                          color:s.r==="alfold"?"#7ab0e0":s.r==="dunantul"?"#c09050":"#a080c0" }}>
                          {s.r==="alfold"?"Alföld":s.r==="dunantul"?"Dunántúl":"Észak"}
                        </span>
                      </td>
                      <td style={{ padding:"4px 8px",fontFamily:"monospace",fontSize:11,fontWeight:600 }}>{model===1?s.th:s.iv}</td>
                      <td style={{ padding:"4px 8px",fontWeight:700,color:rc(s.p),fontFamily:"monospace",fontSize:13 }}>{s.p}%</td>
                      <td style={{ padding:"4px 8px" }}>
                        <span style={{ padding:"2px 6px",borderRadius:3,fontSize:9,fontWeight:600,background:`${rc(s.p)}22`,color:rc(s.p) }}>
                          {re(s.p)} {rl(s.p)}
                        </span>
                      </td>
                      <td style={{ padding:"4px 8px",fontSize:9,color:dim }}>—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* MÓDSZERTAN */}
      {tab==="info" && (
        <div style={{ padding:"10px 20px 16px",fontSize:12,lineHeight:1.75 }}>
          <div style={{ background:"rgba(255,255,255,0.02)",borderRadius:8,border:`1px solid ${bd}`,padding:16 }}>
            <h3 style={{ color:"#d4a020",margin:"0 0 12px",fontSize:15,borderBottom:`1px solid ${bd}`,paddingBottom:8 }}>📚 Irodalom és módszertan</h3>
            <div style={{ background:"rgba(212,160,32,0.08)",border:"1px solid rgba(212,160,32,0.2)",borderRadius:6,padding:"10px 14px",marginBottom:12,fontSize:11 }}>
              <div style={{ fontWeight:700,marginBottom:4,color:"#e8c050" }}>Elsődleges hivatkozás:</div>
              <div style={{ fontFamily:"monospace",fontSize:11,lineHeight:1.6,color:mid }}>
                Mesterházy Á., Bartók T., Mirocha C.G., Komoroczy R. (1999):<br/>
                <em>"Nature of wheat resistance to Fusarium head blight and the role of deoxynivalenol for breeding."</em><br/>
                <strong>Plant Breeding</strong> 118: 97–110. DOI: 10.1046/j.1439-0523.1999.118001097.x
              </div>
            </div>
            <div style={{ background:"rgba(212,160,32,0.05)",border:"1px solid rgba(212,160,32,0.1)",borderRadius:6,padding:"10px 14px",marginBottom:12,fontSize:11 }}>
              <div style={{ fontWeight:700,marginBottom:4,color:"#e8c050" }}>Magyar adaptáció:</div>
              <div style={{ fontFamily:"monospace",fontSize:11,lineHeight:1.6,color:mid }}>
                Gyimes E., Véha A., Szabó B.P., Galbács Z. (2012):<br/>
                <em>"Fusarium fertőzés előrejelzése meteorológiai adatok alapján."</em><br/>
                <strong>Növényvédelem</strong> 48(8): 347–352.
              </div>
            </div>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12 }}>
              {[
                {t:"① TRH9010",f:"p% = −3.3756 + 6.8128 × TRH9010",d:"7 napos ablakban a leghosszabb egybefüggő órasorozat ahol RH > 90% ÉS 15°C ≤ T ≤ 30°C"},
                {t:"② INT3",f:"p% = −3.7251 + 10.5097 × INT3",d:"(virágzás utáni max RH>90% h) × (virágzás előtti 15–30°C arány). Virágzás = ablak 4. napja"},
              ].map((m,i)=>(
                <div key={i} style={{ background:"rgba(255,255,255,0.02)",borderRadius:6,padding:10,border:`1px solid ${bd}` }}>
                  <div style={{ fontWeight:700,color:"#e8c050",marginBottom:5,fontSize:12 }}>{m.t}</div>
                  <div style={{ fontFamily:"monospace",background:"rgba(0,0,0,0.3)",padding:"4px 7px",borderRadius:4,marginBottom:5,fontSize:11 }}>{m.f}</div>
                  <div style={{ color:dim,fontSize:10,lineHeight:1.5 }}>{m.d}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div style={{ padding:"6px 20px 14px",textAlign:"center",fontSize:9,color:dim,borderTop:`1px solid ${bd}` }}>
        Mesterházy et al. (1999) Plant Breeding 118:97–110 · Gyimes et al. (2012) Növényvédelem 48(8) · HungaroMet ODP · OpenStreetMap
      </div>
    </div>
  );
}
