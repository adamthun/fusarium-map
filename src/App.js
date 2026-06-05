import { useState, useEffect, useRef, useCallback } from "react";

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

// 30 állomás – országos monitoring hálózat
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

const HU = { minLat:45.7, maxLat:48.65, minLon:16.0, maxLon:23.1 };
const MW = 540, MH = 320;
function lx(lon) { return ((lon-HU.minLon)/(HU.maxLon-HU.minLon))*MW; }
function ly(lat) { return ((HU.maxLat-lat)/(HU.maxLat-HU.minLat))*MH; }

function rc(p) {
  if (p<=0)  return "#16502e";
  if (p<=10) return "#2e7d35";
  if (p<=25) return "#72a82e";
  if (p<=40) return "#c8b820";
  if (p<=60) return "#d97820";
  if (p<=80) return "#c03518";
  return "#8b1010";
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
function advice(p) {
  if (p<=0)  return "Nincs fertőzési körülmény";
  if (p<=10) return "Minimális — nem indokol beavatkozást";
  if (p<=25) return "Mérsékelt — figyelemmel kísérés javasolt";
  if (p<=40) return "Közepes — fontoljon meg gombaölőszert";
  if (p<=60) return "Magas — gombaölőszer-kezelés indokolt";
  if (p<=80) return "Veszélyes — azonnali védekezés szükséges";
  return "Kritikus — azonnali beavatkozás!";
}

// Supabase Edge Function hívás
async function apiFetch(params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${EDGE_FN}?${qs}`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` }
  });
  if (!r.ok) throw new Error(`API ${r.status}`);
  return r.json();
}

// Demo fallback ha nincs adat
function demoData(date, model) {
  const h = s => { let x=0; for(let c of s) x=Math.imul(31,x)+c.charCodeAt(0); return x>>>0; };
  return STATIONS.map(s => {
    const base = s.lon < 18 ? 45 : s.lon < 20 ? 22 : 12;
    const noise = (h(String(s.id)+date) % 1000)/1000*55 - 10;
    const p = Math.max(0, Math.min(100, base+noise+(model===2?8:0)));
    return { ...s, p:+p.toFixed(1),
      th: model===1 ? Math.round(p/6.8) : null,
      iv: model===2 ? +(p/10.5).toFixed(2) : null,
      obs_count: 168 };
  }).sort((a,b)=>b.p-a.p);
}

export default function App() {
  const today = new Date().toISOString().split("T")[0];
  const [date, setDate]     = useState(today);
  const [model, setModel]   = useState(1);
  const [data, setData]     = useState([]);
  const [dates, setDates]   = useState([today]);
  const [loading, setLoading] = useState(true);
  const [src, setSrc]       = useState("loading");
  const [lastUp, setLastUp] = useState(null);
  const [hover, setHover]   = useState(null);
  const [tab, setTab]         = useState("map");
  const [region, setRegion]   = useState("all");
  const [mapStyle, setMapStyle] = useState("osm");
  const [showHeat, setShowHeat] = useState(true);
  const [forecast, setForecast] = useState({});
  const [forecastDates, setForecastDates] = useState([]);
  const [isForecast, setIsForecast] = useState(false);
  const [selYear, setSelYear] = useState(new Date().getFullYear());
  const [selMonth, setSelMonth] = useState(new Date().getMonth());

  // Elérhető dátumok betöltése
  useEffect(() => {
    apiFetch({ action:"dates" })
      .then(r => { if (r.dates?.length) { setDates(r.dates); setDate(r.dates[0]); } })
      .catch(() => {});
  }, []);

  // Kockázati adatok betöltése
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch({ action:"risk", date, model:String(model) })
      .then(r => {
        if (cancelled) return;
        if (r.data?.length > 0) {
          // Supabase adatok + az összes állomás koordinátájával kiegészítve
          const byId = Object.fromEntries(r.data.map(d => [d.station_id, d]));
          const merged = STATIONS.map(s => {
            const db = byId[s.id];
            if (!db) return null;
            return { ...s, p:+db.risk_pct, th:db.trh9010_hours?+db.trh9010_hours:null,
              iv:db.int3_value?+db.int3_value:null, obs_count:db.obs_count,
              calc_date:db.calc_date };
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

  const filtered = region==="all" ? data : data.filter(s=>s.r===region);
  const maxR = data.length ? Math.max(...data.map(d=>d.p)) : 0;
  const avgR = data.length ? data.reduce((s,d)=>s+d.p,0)/data.length : 0;
  const hi   = data.filter(d=>d.p>=60).length;

  const bd  = "rgba(255,255,255,0.06)";
  const dim = "rgba(232,228,220,0.35)";
  const mid = "rgba(232,228,220,0.6)";

  return (
    <div style={{ fontFamily:"Georgia,serif", background:"#090d18", minHeight:"100vh", color:"#e8e4dc" }}>

      {/* HEADER */}
      <div style={{ padding:"14px 20px 10px", background:"linear-gradient(90deg,rgba(180,40,20,0.1),rgba(50,110,30,0.06))", borderBottom:`1px solid ${bd}` }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:36,height:36,borderRadius:"50%",background:"linear-gradient(135deg,#c04020,#d4a020)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,color:"#fff",fontSize:14 }}>Fz</div>
          <div>
            <div style={{ fontSize:19,fontWeight:700 }}>Fusarium Kockázati Térkép</div>
            <div style={{ fontSize:10,color:dim,letterSpacing:"0.08em",textTransform:"uppercase" }}>
              Magyarország · 30 OMSZ állomás · HungaroMet ODP
              {src==="live" && <span style={{ color:"#4a8c2b",marginLeft:6 }}>● ÉLŐ ADAT</span>}
              {src==="demo" && <span style={{ color:"#b07020",marginLeft:6 }}>● DEMO MÓD</span>}
              {loading      && <span style={{ color:"#507090",marginLeft:6 }}>● Betöltés...</span>}
            </div>
          </div>
          {lastUp && (
            <div style={{ marginLeft:"auto",fontSize:10,color:dim,textAlign:"right" }}>
              Frissítve<br/>
              <span style={{ color:"#4a8c2b",fontFamily:"monospace" }}>
                {new Date(lastUp).toLocaleString("hu-HU")}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* STATISZTIKA */}
      <div style={{ display:"flex",gap:6,padding:"8px 20px" }}>
        {[
          {l:"Max kockázat",v:`${maxR.toFixed(0)}%`,c:rc(maxR)},
          {l:"Átlag",v:`${avgR.toFixed(1)}%`,c:rc(avgR)},
          {l:"Veszélyes+",v:`${hi} db`,c:hi>0?"#c84020":"#4a8c2b"},
          {l:"Állomások",v:`${data.length}/30`,c:"#6a7a8a"},
        ].map((c,i)=>(
          <div key={i} style={{ flex:1,background:"rgba(255,255,255,0.03)",borderRadius:6,padding:"5px 10px",border:`1px solid ${bd}` }}>
            <div style={{ fontSize:8,textTransform:"uppercase",letterSpacing:"0.09em",color:dim }}>{c.l}</div>
            <div style={{ fontSize:16,fontWeight:700,color:c.c,fontFamily:"monospace" }}>{c.v}</div>
          </div>
        ))}
      </div>

      {/* KONTROLLOK */}
      <div style={{ display:"flex",flexWrap:"wrap",gap:10,padding:"6px 20px 10px",borderBottom:`1px solid ${bd}`,alignItems:"flex-end" }}>
        {/* SZEZON NAPTÁR */}
        {(() => {
          const today = new Date().toISOString().split("T")[0];
          const cur = new Date().getFullYear();
          const years = [cur-2, cur-1, cur];
          const sMons = [3,4,5,6,7,8,9]; // ápr–okt
          const mNames = ["Jan","Feb","Már","Ápr","Máj","Jún","Júl","Aug","Sze","Okt","Nov","Dec"];
          const getDays = (y,m) => {
            const days=[], n=new Date(y,m+1,0).getDate();
            for(let d=1;d<=n;d++) days.push(`${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`);
            return days;
          };
          const mDays = getDays(selYear, selMonth);
          const firstMon = ((new Date(selYear,selMonth,1).getDay())+6)%7;
          return (
            <div style={{ minWidth:220 }}>
              {/* Év */}
              <div style={{ display:"flex", gap:3, marginBottom:5, alignItems:"center" }}>
                <span style={{ fontSize:8,color:dim,textTransform:"uppercase",letterSpacing:"0.1em",marginRight:3 }}>Szezon</span>
                {years.map(y=>(
                  <button key={y} onClick={()=>{setSelYear(y);setSelMonth(4);}} style={{
                    padding:"2px 7px",borderRadius:4,cursor:"pointer",fontSize:11,fontFamily:"monospace",
                    fontWeight:selYear===y?700:400,
                    background:selYear===y?"rgba(200,64,32,0.3)":"rgba(255,255,255,0.05)",
                    color:selYear===y?"#f0ece4":dim,
                    border:`1px solid ${selYear===y?"rgba(200,64,32,0.5)":"rgba(255,255,255,0.08)"}`,
                  }}>{y}</button>
                ))}
              </div>
              {/* Hónap */}
              <div style={{ display:"flex", gap:2, marginBottom:5 }}>
                {sMons.map(m=>{
                  const has = dates.some(d=>d.startsWith(`${selYear}-${String(m+1).padStart(2,"0")}`));
                  const hasFc = forecastDates.some(d=>d.startsWith(`${selYear}-${String(m+1).padStart(2,"0")}`));
                  return (
                    <button key={m} onClick={()=>setSelMonth(m)} style={{
                      padding:"2px 5px",borderRadius:4,cursor:"pointer",fontSize:9,
                      fontWeight:selMonth===m?700:400,position:"relative",
                      background:selMonth===m?"rgba(255,255,255,0.12)":"rgba(255,255,255,0.04)",
                      color:selMonth===m?"#f0ece4":has||hasFc?dim:"rgba(255,255,255,0.2)",
                      border:`1px solid ${selMonth===m?"rgba(255,255,255,0.25)":"rgba(255,255,255,0.07)"}`,
                    }}>
                      {mNames[m]}
                      {(has||hasFc)&&<span style={{ position:"absolute",top:1,right:1,width:3,height:3,borderRadius:"50%",background:hasFc?"#fbbf24":"#4a8c2b" }}/>}
                    </button>
                  );
                })}
              </div>
              {/* Napok */}
              <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:1,marginBottom:2 }}>
                {["H","K","Sz","Cs","P","Sz","V"].map((d,i)=>(
                  <div key={i} style={{ textAlign:"center",fontSize:7,color:"rgba(255,255,255,0.2)" }}>{d}</div>
                ))}
              </div>
              <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:1 }}>
                {Array(firstMon).fill(null).map((_,i)=><div key={`e${i}`}/>)}
                {mDays.map(d=>{
                  const has=dates.includes(d), isFc=forecastDates.includes(d), isSel=date===d;
                  const dn=parseInt(d.slice(8));
                  return (
                    <button key={d} onClick={()=>(has||isFc)&&setDate(d)} disabled={!has&&!isFc} style={{
                      padding:"3px 0",borderRadius:3,textAlign:"center",fontSize:9,fontFamily:"monospace",
                      cursor:(has||isFc)?"pointer":"default",
                      background:isSel?(isFc?"rgba(251,191,36,0.35)":"rgba(200,64,32,0.4)"):has?"rgba(74,140,43,0.15)":isFc?"rgba(251,191,36,0.08)":"transparent",
                      color:isSel?"#f0ece4":has?"#a0d070":isFc?"rgba(251,191,36,0.7)":"rgba(255,255,255,0.12)",
                      border:`1px solid ${isSel?(isFc?"rgba(251,191,36,0.6)":"rgba(200,64,32,0.6)"):has?"rgba(74,140,43,0.3)":isFc?"rgba(251,191,36,0.2)":"transparent"}`,
                      fontWeight:isSel?700:400,
                    }}>{dn}</button>
                  );
                })}
              </div>
              <div style={{ display:"flex",gap:8,marginTop:4,fontSize:8,color:dim }}>
                <span><span style={{ display:"inline-block",width:5,height:5,borderRadius:"50%",background:"#4a8c2b",marginRight:2 }}/>Mért</span>
                <span><span style={{ display:"inline-block",width:5,height:5,borderRadius:"50%",background:"#fbbf24",marginRight:2 }}/>Előrejelzés</span>
                <span style={{ marginLeft:"auto",fontFamily:"monospace",color:isForecast?"#fbbf24":"#a0d070",fontWeight:600,fontSize:9 }}>{date}</span>
              </div>
            </div>
          );
        })()}
        <div>
          <div style={{ fontSize:8,color:dim,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:3 }}>Modell</div>
          <div style={{ display:"flex" }}>
            {[{id:1,l:"① TRH9010"},{id:2,l:"② INT3"}].map(m=>(
              <button key={m.id} onClick={()=>setModel(m.id)} style={{
                padding:"5px 12px",fontSize:11,fontFamily:"inherit",cursor:"pointer",
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
            style={{ background:"rgba(255,255,255,0.04)",border:`1px solid ${bd}`,borderRadius:5,padding:"5px 8px",color:"#e8e4dc",fontSize:12,fontFamily:"monospace" }}>
            <option value="all" style={{background:"#0d1525"}}>Összes</option>
            <option value="alfold" style={{background:"#0d1525"}}>Nagyalföld</option>
            <option value="dunantul" style={{background:"#0d1525"}}>Dunántúl</option>
            <option value="eszak" style={{background:"#0d1525"}}>Észak-Mo.</option>
          </select>
        </div>
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

      {/* TÉRKÉP */}
      {tab==="map" && (
        <div style={{ padding:"10px 20px 4px" }}>
          <div style={{ background:"rgba(255,255,255,0.02)",borderRadius:8,border:`1px solid ${bd}`,overflow:"hidden",position:"relative" }}>
            <svg viewBox={`0 0 ${MW} ${MH}`} style={{ width:"100%",height:"auto",display:"block" }}>
              <rect width={MW} height={MH} fill="#0d1828"/>
              {[17,18,19,20,21,22].map(lon=>(
                <g key={lon}>
                  <line x1={lx(lon)} y1={0} x2={lx(lon)} y2={MH} stroke="rgba(255,255,255,0.04)" strokeWidth="0.5"/>
                  <text x={lx(lon)} y={MH-3} textAnchor="middle" fontSize="6" fill="rgba(255,255,255,0.15)" fontFamily="monospace">{lon}°E</text>
                </g>
              ))}
              {[46,47,48].map(lat=>(
                <g key={lat}>
                  <line x1={0} y1={ly(lat)} x2={MW} y2={ly(lat)} stroke="rgba(255,255,255,0.04)" strokeWidth="0.5"/>
                  <text x={4} y={ly(lat)+2} fontSize="6" fill="rgba(255,255,255,0.15)" fontFamily="monospace">{lat}°N</text>
                </g>
              ))}
              <defs>
                {data.map(s=>(
                  <radialGradient key={`rg${s.id}`} id={`rg${s.id}`} cx="50%" cy="50%" r="50%">
                    <stop offset="0%"   stopColor={rc(s.p)} stopOpacity="0.7"/>
                    <stop offset="45%"  stopColor={rc(s.p)} stopOpacity="0.25"/>
                    <stop offset="100%" stopColor={rc(s.p)} stopOpacity="0"/>
                  </radialGradient>
                ))}
              </defs>
              <g>
                {data.map(s=>(
                  <circle key={`b${s.id}`} cx={lx(s.lon)} cy={ly(s.lat)}
                    r={Math.max(20,15+s.p*0.5)} fill={`url(#rg${s.id})`}/>
                ))}
              </g>
              {data.map(s=>{
                const cx=lx(s.lon), cy=ly(s.lat);
                const active=hover?.id===s.id;
                const faded=region!=="all"&&s.r!==region;
                return (
                  <g key={s.id} onMouseEnter={()=>setHover(s)} onMouseLeave={()=>setHover(null)}
                    style={{ cursor:"pointer",opacity:faded?0.2:1 }}>
                    {active&&<circle cx={cx} cy={cy} r={18} fill={rc(s.p)} opacity={0.25}/>}
                    <circle cx={cx} cy={cy} r={s.ref?7.5:5.5} fill={rc(s.p)}
                      stroke={s.ref?"rgba(255,220,60,0.9)":"rgba(255,255,255,0.65)"}
                      strokeWidth={s.ref?1.5:1}/>
                    {(active||s.p>=50)&&(
                      <text x={cx} y={cy-11} textAnchor="middle" fontSize="7" fontWeight="700"
                        fill={rc(s.p)} fontFamily="monospace">{Math.round(s.p)}%</text>
                    )}
                  </g>
                );
              })}
              <text x={MW/2} y={10} textAnchor="middle" fontSize="8" fill="rgba(255,255,255,0.15)" fontFamily="serif">É</text>
              <text x={MW/2} y={MH-4} textAnchor="middle" fontSize="8" fill="rgba(255,255,255,0.15)" fontFamily="serif">D</text>
            </svg>

            {hover&&(
              <div style={{ position:"absolute",left:"50%",bottom:8,transform:"translateX(-50%)",
                background:"rgba(5,8,16,0.97)",border:"1px solid rgba(255,255,255,0.12)",
                borderRadius:8,padding:"10px 14px",fontSize:12,minWidth:270,pointerEvents:"none",zIndex:10 }}>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start" }}>
                  <div>
                    <div style={{ fontWeight:700,fontSize:14 }}>
                      {hover.nm}
                      {hover.ref&&<span style={{ marginLeft:6,fontSize:9,color:"#ffd040",border:"1px solid #ffd040",borderRadius:3,padding:"1px 4px" }}>REF</span>}
                    </div>
                    <div style={{ color:dim,fontSize:9 }}>{hover.county} · {hover.lat.toFixed(2)}°N {hover.lon.toFixed(2)}°E</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:22,fontWeight:800,color:rc(hover.p),fontFamily:"monospace" }}>{hover.p}%</div>
                    <div style={{ fontSize:10,color:rc(hover.p),fontWeight:600 }}>{re(hover.p)} {rl(hover.p)}</div>
                  </div>
                </div>
                <div style={{ marginTop:6,paddingTop:6,borderTop:"1px solid rgba(255,255,255,0.07)",fontSize:10,color:mid }}>{advice(hover.p)}</div>
                <div style={{ marginTop:3,fontSize:9,color:dim,fontFamily:"monospace" }}>
                  {model===1&&hover.th!=null&&`TRH9010 = ${hover.th} h (RH>90%, 15≤T≤30°C)`}
                  {model===2&&hover.iv!=null&&`INT3 = ${hover.iv}`}
                  {hover.obs_count!=null&&` · ${hover.obs_count} óra adat`}
                </div>
              </div>
            )}
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:2,justifyContent:"center",padding:"4px 0 6px" }}>
            <span style={{ fontSize:8,color:dim,marginRight:4,textTransform:"uppercase",letterSpacing:"0.08em" }}>Kockázat</span>
            {[0,10,25,40,60,80,100].map(v=>(
              <div key={v} style={{ display:"flex",alignItems:"center",gap:2 }}>
                <div style={{ width:16,height:6,borderRadius:1,background:rc(v) }}/>
                <span style={{ fontSize:7,color:dim }}>{v}%</span>
              </div>
            ))}
            <div style={{ marginLeft:10,display:"flex",alignItems:"center",gap:4,fontSize:8,color:dim }}>
              <div style={{ width:7,height:7,borderRadius:"50%",background:"#888",border:"1.5px solid #ffd040" }}/>REF (MTA ATK)
            </div>
          </div>
        </div>
      )}

      {/* TÁBLÁZAT */}
      {tab==="table"&&(
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
                    {["#","Állomás","Megye","Régió",model===1?"TRH9010(h)":"INT3","p%","Szint","Javaslat"].map(h=>(
                      <th key={h} style={{ padding:"5px 8px",textAlign:"left",color:dim,fontWeight:500,fontSize:8,textTransform:"uppercase" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s,i)=>(
                    <tr key={s.id} onMouseEnter={()=>setHover(s)} onMouseLeave={()=>setHover(null)}
                      style={{ borderBottom:"1px solid rgba(255,255,255,0.025)",background:hover?.id===s.id?"rgba(255,255,255,0.04)":(i%2?"transparent":"rgba(255,255,255,0.01)"),cursor:"pointer" }}>
                      <td style={{ padding:"4px 8px",color:dim,fontFamily:"monospace",fontSize:9 }}>{i+1}</td>
                      <td style={{ padding:"4px 8px",fontWeight:600 }}>{s.nm}{s.ref&&<span style={{ marginLeft:4,fontSize:8,color:"#ffd040" }}>★</span>}</td>
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
                      <td style={{ padding:"4px 8px",fontSize:9,color:mid }}>{s.p>=60?"⚠ Kezelés indokolt":s.p>=40?"Figyelés ajánlott":"—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* MÓDSZERTAN */}
      {tab==="info"&&(
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
                {t:"① TRH9010 modell",f:"p% = −3.3756 + 6.8128 × TRH9010",d:"TRH9010 = 7 napos ablakban a leghosszabb egybefüggő órasorozat, ahol RH > 90% ÉS 15°C ≤ T ≤ 30°C"},
                {t:"② INT3 interakciós modell",f:"p% = −3.7251 + 10.5097 × INT3",d:"INT3 = (virágzás utáni max. egybefüggő RH>90% óra) × (virágzás előtti 15–30°C arány). Virágzás = ablak 4. napja"},
              ].map((m,i)=>(
                <div key={i} style={{ background:"rgba(255,255,255,0.02)",borderRadius:6,padding:10,border:`1px solid ${bd}` }}>
                  <div style={{ fontWeight:700,color:"#e8c050",marginBottom:5,fontSize:12 }}>{m.t}</div>
                  <div style={{ fontFamily:"monospace",background:"rgba(0,0,0,0.3)",padding:"4px 7px",borderRadius:4,marginBottom:5,fontSize:11 }}>{m.f}</div>
                  <div style={{ color:dim,fontSize:10,lineHeight:1.5 }}>{m.d}</div>
                </div>
              ))}
            </div>
            <div style={{ padding:"8px 12px",background:"rgba(255,255,255,0.02)",borderRadius:6,border:`1px solid ${bd}`,fontSize:10,color:dim }}>
              <strong style={{ color:mid }}>Adatforrás:</strong> HungaroMet ODP szinoptikus óránkénti CSV<br/>
              <code style={{ color:"#d4a020" }}>odp.met.hu/weather/weather_reports/synoptic/hungary/hourly/</code><br/>
              Oszlopok: <code>ta</code> (°C), <code>u</code> (%), adathiány: <code>-999</code><br/>
              DB: Supabase PostgreSQL · daelyokkshcgtbijcfbz · eu-west-1
            </div>
          </div>
        </div>
      )}

      <div style={{ padding:"6px 20px 14px",textAlign:"center",fontSize:9,color:dim,borderTop:`1px solid ${bd}` }}>
        Mesterházy et al. (1999) Plant Breeding 118:97–110 · Gyimes et al. (2012) Növényvédelem 48(8) · HungaroMet ODP
      </div>
    </div>
  );
}
