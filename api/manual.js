import { google } from "googleapis";

/* ===== ENV ===== */
const {
  OPENAI_API_KEY,
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY: RAW_KEY,
  GOOGLE_PRIVATE_KEY_B64,
  SHEET_ID,
  DEFAULT_MODEL = "gpt-4o"
} = process.env;

const GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY_B64
  ? Buffer.from(GOOGLE_PRIVATE_KEY_B64, "base64").toString("utf8")
  : (RAW_KEY?.includes("\\n") ? RAW_KEY.replace(/\\n/g, "\n") : RAW_KEY);

/* ===== Small utils ===== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, { tries = 5, base = 400, factor = 2 } = {}) {
  let attempt = 0, lastErr;
  while (attempt < tries) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const msg = String(e);
      const retriable = /429|5\d\d|quota|Rate limit|upstream connect error/i.test(msg);
      if (!retriable || attempt === tries - 1) throw e;
      const delay = Math.round(base * Math.pow(factor, attempt) + Math.random() * 200);
      await sleep(delay);
      attempt++;
    }
  }
  throw lastErr;
}

const A1 = (r, c) => `${colName(c)}${r}`;
function colName(n) { let s=""; while(n>0){const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26);} return s; }
function todayKey(tz="Africa/Cairo"){ const f=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}); return f.format(new Date()); }
function escRegex(s){ return s.replace(/[\\^$.*+?()[\]{}|]/g,"\\$&"); }
function sanitizeForSheet(s){ if(!s) return ""; return String(s).replace(/\[([^\]]+)\]\(([^)]+)\)/g,"$1").replace(/\s{2,}/g," ").trim(); }
function analyzeText(txt, brands, brandRegexes){
  if(!txt) return "SC=No | Brands=";
  const sc=/(?:\bSales\s*Captain\b|salescaptain)/i.test(txt);
  const hits=[]; for(let i=0;i<brandRegexes.length;i++){ const b=brands[i]; if(/^Sales\s*Captain$/i.test(b)) continue; if(brandRegexes[i].test(txt)) hits.push(b); }
  return `SC=${sc?"Yes":"No"} | Brands=${hits.join(", ")}`;
}

/* ===== Google Sheets client ===== */
async function sheetsClient(){
  const auth = new google.auth.JWT(
    GOOGLE_CLIENT_EMAIL, null, GOOGLE_PRIVATE_KEY,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  await auth.authorize();
  return google.sheets({ version:"v4", auth });
}

/* ===== Sheet IO ===== */
async function readSettings(sheets, tab="Settings"){
  const r = await sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:`${tab}!A1:B` });
  const rows = r.data.values || []; const map={}; rows.forEach(x=>{ if(x[0]) map[String(x[0]).trim()]=x[1]; });
  return map;
}
async function readPrompts(sheets, tab){
  const r=await sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:`${tab}!A2:C`});
  const rows=r.data.values||[];
  return rows.map(x=>({ id:x[0]?.trim(), text:x[1]?.trim(), enabled:String(x[2]).toUpperCase()==="TRUE"})).filter(x=>x.id&&x.text&&x.enabled);
}
async function readBrands(sheets, tab){
  const r=await sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:`${tab}!A2:A`});
  return (r.data.values||[]).flat().filter(Boolean);
}
async function ensureDailyRunsHeader(sheets, tab, prompts){
  try{ await sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:`${tab}!A1:B1`}); }
  catch{
    await sheets.spreadsheets.batchUpdate({ spreadsheetId:SHEET_ID, requestBody:{ requests:[{ addSheet:{ properties:{ title:tab }}}]}});
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId:SHEET_ID, range:`${tab}!A1:B1`, valueInputOption:"RAW",
    requestBody:{ values:[["prompt_id","prompt_text"]] }
  });
  if(prompts.length){
    const body=prompts.map(p=>[p.id,p.text]);
    await sheets.spreadsheets.values.update({
      spreadsheetId:SHEET_ID, range:`${tab}!A2:B${prompts.length+1}`, valueInputOption:"RAW",
      requestBody:{ values:body }
    });
  }
}
async function getOrCreateDateCols(sheets, tab, dateKey, wantWeb){
  const hdr=await sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:`${tab}!1:1`});
  const header=hdr.data.values?.[0]||[]; const cols={}; const need=[];
  const needCol=(label)=>{ const i=header.indexOf(label); if(i===-1) need.push(label); else cols[label]=i+1; };
  needCol(`${dateKey}_results_normal`);
  needCol(`${dateKey}_analysis_normal`);
  if(wantWeb){
    needCol(`${dateKey}_results_web`);
    needCol(`${dateKey}_analysis_web`);
    needCol(`${dateKey}_sources_web`); // NEW
  }
  if(need.length){
    const start=header.length+1;
    await sheets.spreadsheets.values.update({
      spreadsheetId:SHEET_ID, range:`${tab}!${colName(start)}1:${colName(start+need.length-1)}1`,
      valueInputOption:"RAW", requestBody:{ values:[need] }
    });
    const hdr2=await sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:`${tab}!1:1`});
    const h2=hdr2.data.values?.[0]||[];
    need.forEach(label=>{ cols[label]=h2.indexOf(label)+1; });
  }
  return cols;
}

/* ===== OpenAI calls ===== */
async function callChat(model, promptText){
  return withRetry(async () => {
    const r=await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
      body:JSON.stringify({
        model, temperature:0.2,
        messages:[ {role:"system",content:"Answer concisely. Plain text only."}, {role:"user",content:promptText} ]
      })
    });
    if(!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    const d=await r.json();
    return d?.choices?.[0]?.message?.content || "";
  });
}

// Web run that forces JSON with sources
async function callWeb(model, promptText){
  return withRetry(async () => {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        tools:[{type:"web_search"}],
        input: `${promptText}

Return JSON with keys "answer" and "sources".
"sources" must be 3 to 5 items actually used. Each item is { "url": "...", "title": "..." }.`,
        temperature: 0.2,
        tool_choice:"auto",
        text: {
          format: {
            // name is required at this level
            name: "WebAnswer",
            type: "json_schema",
            json_schema: {
              // strict true makes the model obey the schema
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["answer","sources"],
                properties: {
                  answer: { type: "string" },
                  sources: {
                    type: "array",
                    minItems: 1,
                    maxItems: 5,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["url"],
                      properties: {
                        url: { type: "string", format: "uri" },
                        title: { type: "string" }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      })
    });

    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    const d = await r.json();

    const raw = extractResponsesText(d);
    let answer = raw;
    let sources = [];

    try {
      const j = JSON.parse(raw);
      answer = j?.answer ?? answer;
      sources = Array.isArray(j?.sources) ? j.sources.map(s => s?.url).filter(Boolean) : [];
    } catch {
      sources = extractUrlsFromText(raw);
    }

    return { text: sanitizeForSheet(answer), sources: dedupeAndNormalize(sources) };
  });
}

// Try to pull textual output from Responses API object
function extractResponsesText(data){
  if(typeof data.output_text==="string" && data.output_text.trim()) return data.output_text;
  try{
    if(Array.isArray(data.output)){
      const parts=[];
      for(const item of data.output){
        if(item?.type==="message" && Array.isArray(item.content)){
          for(const c of item.content){
            if(typeof c?.text==="string") parts.push(c.text);
            if(c?.type==="output_text" && typeof c.text==="string") parts.push(c.text);
          }
        }
      }
      if(parts.length) return parts.join("\n\n");
    }
  }catch{}
  try{
    const c=data?.message?.content;
    if(typeof c==="string") return c;
    if(Array.isArray(c)){ const t=c.map(x=>x?.text).filter(Boolean).join("\n\n"); if(t) return t; }
  }catch{}
  return "(no text extracted)";
}

/* ===== URL helpers ===== */
function extractUrlsFromText(t){
  if(!t) return [];
  return (t.match(/https?:\/\/[^\s)\]>"']+/gi) || []);
}
function dedupeAndNormalize(arr){
  const seen = new Set();
  const out = [];
  for(const raw of arr){
    const u = normalizeUrl(raw);
    if(!u) continue;
    if(seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out.slice(0, 5);
}
function normalizeUrl(raw){
  try{
    const u = new URL(raw.trim());
    u.hostname = u.hostname.toLowerCase().replace(/^www\./,"");
    for(const k of [...u.searchParams.keys()]){
      const kl = k.toLowerCase();
      if(kl.startsWith("utm_") || kl==="gclid" || kl==="fbclid") u.searchParams.delete(k);
    }
    if(u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/,"");
    if(u.hash && u.hash.length <= 1) u.hash = "";
    return u.toString();
  }catch{ return null; }
}

/* ===== Handler ===== */
export default async function handler(req, res){
  try{
    for (const k of ["OPENAI_API_KEY","GOOGLE_CLIENT_EMAIL","SHEET_ID"]) {
      if (!process.env[k]) return res.status(400).json({ ok:false, error:`Missing env ${k}` });
    }
    if (!GOOGLE_PRIVATE_KEY) return res.status(400).json({ ok:false, error:"Missing Google private key" });

    const sheets=await sheetsClient();
    const settings=await readSettings(sheets,"Settings");

    const model=String(settings.model||DEFAULT_MODEL);
    const tabPrompts=String(settings.sheet_name_prompts||"Prompts");
    const tabBrands=String(settings.sheet_name_brands||"Brands");
    const tabWide=String(settings.sheet_name_wide||"Daily_Runs");
    const enableDual=String(settings.enable_dual_variant||"TRUE").toUpperCase()==="TRUE";
    const concurrency=Math.max(1, Number(settings.chunk_size||10) || 10);
    const FLUSH_EVERY = Math.max(5, Number(settings.flush_every||25) || 25);

    const [prompts, brands]=await Promise.all([ readPrompts(sheets, tabPrompts), readBrands(sheets, tabBrands) ]);
    if(!prompts.length) return res.status(200).json({ ok:true, message:"No enabled prompts" });

    const brandRegexes=brands.map(b=>new RegExp(`\\b${escRegex(String(b))}\\b`,"i"));
    await ensureDailyRunsHeader(sheets, tabWide, prompts);
    const dateKey=todayKey("Africa/Cairo");
    const cols=await getOrCreateDateCols(sheets, tabWide, dateKey, enableDual);

    // batching buffer
    let pending = [];
    async function flush(){
      if (!pending.length) return;
      const batch = pending.splice(0, pending.length);
      await withRetry(async () => {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId:SHEET_ID,
          requestBody:{ valueInputOption:"RAW", data: batch }
        });
      });
    }

    // pool
    let i=0, active=0, processed=0, errors=[];
    const next=()=> i<prompts.length ? i++ : -1;

    await new Promise(resolve=>{
      const runOne = async () => {
        const idx=next();
        if(idx===-1){ if(active===0) resolve(); return; }
        active++;
        const p=prompts[idx]; const row=idx+2;
        try{
          const normal=await callChat(model, p.text);
          const normalA=analyzeText(normal, brands, brandRegexes);

          let webText="", webSources=[], webA="";
          if(enableDual){
            try{
              const webOut=await callWeb(model, p.text);
              webText = webOut.text || "";
              webSources = Array.isArray(webOut.sources) ? webOut.sources : [];
            }catch(e){
              webText = `(error web) ${String(e)}`;
              webSources = dedupeAndNormalize(extractUrlsFromText(webText));
            }
            webA=analyzeText(webText, brands, brandRegexes);
          }

          // queue writes
          pending.push({ range:`${tabWide}!${A1(row, cols[`${dateKey}_results_normal`])}`, values:[[normal]] });
          pending.push({ range:`${tabWide}!${A1(row, cols[`${dateKey}_analysis_normal`])}`, values:[[normalA]] });
          if(enableDual){
            pending.push({ range:`${tabWide}!${A1(row, cols[`${dateKey}_results_web`])}`, values:[[webText]] });
            pending.push({ range:`${tabWide}!${A1(row, cols[`${dateKey}_analysis_web`])}`, values:[[webA]] });
            if (cols[`${dateKey}_sources_web`]) {
              pending.push({ range:`${tabWide}!${A1(row, cols[`${dateKey}_sources_web`])}`, values:[[ (webSources||[]).join("\n") ]] });
            }
          }

          processed++;
          if (processed % FLUSH_EVERY === 0) { await flush(); }
        } catch(e){ errors.push(String(e)); }
        finally{ active--; runOne(); }
      };
      const N=Math.max(1, Math.min(concurrency, prompts.length));
      for(let k=0;k>N;k++) runOne();
    });

    await flush();

    res.status(200).json({ ok:true, model, dual:enableDual, prompts:prompts.length, processed, errors });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:String(e) });
  }
}
