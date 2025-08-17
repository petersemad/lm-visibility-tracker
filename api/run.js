import { google } from "googleapis";
import pLimit from "p-limit";

/** ENV */
const {
  OPENAI_API_KEY,
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY: GOOGLE_PRIVATE_KEY_RAW,
  SHEET_ID,
  DEFAULT_MODEL = "gpt-4o"
} = process.env;
const GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY_RAW?.includes("\\n")
  ? GOOGLE_PRIVATE_KEY_RAW.replace(/\\n/g, "\n")
  : GOOGLE_PRIVATE_KEY_RAW;

/** Google Sheets client */
async function sheetsClient() {
  const auth = new google.auth.JWT(
    GOOGLE_CLIENT_EMAIL,
    null,
    GOOGLE_PRIVATE_KEY,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

/** Small helpers */
const A1 = (row, col) => `${colNumToName(col)}${row}`;
function colNumToName(n) { let s=""; while(n>0){const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26);} return s; }
function todayKey(tz="Africa/Cairo"){ const f=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}); return f.format(new Date()); }
function escRegex(s){ return s.replace(/[\\^$.*+?()[\]{}|]/g,"\\$&"); }
function analyzeText(txt, brands, brandRegexes) {
  if (!txt) return "SC=No | Brands=";
  const sc = /(?:\bSales\s*Captain\b|salescaptain)/i.test(txt);
  const hits = [];
  for (let i=0;i<brandRegexes.length;i++){
    const b = brands[i];
    if (/^Sales\s*Captain$/i.test(b)) continue;
    if (brandRegexes[i].test(txt)) hits.push(b);
  }
  return `SC=${sc ? "Yes" : "No"} | Brands=${hits.join(", ")}`;
}

/** Sheet IO */
async function readSettings(sheets, tab="Settings") {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:B` });
  const rows = res.data.values || [];
  const map = {};
  rows.forEach(r => { if (r[0]) map[String(r[0]).trim()] = r[1]; });
  return map;
}
async function readPrompts(sheets, tab) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A2:C` });
  const rows = res.data.values || [];
  return rows
    .map(r => ({ id: r[0]?.trim(), text: r[1]?.trim(), enabled: String(r[2]).toUpperCase()==="TRUE" }))
    .filter(r => r.id && r.text && r.enabled);
}
async function readBrands(sheets, tab) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A2:A` });
  return (res.data.values || []).flat().filter(Boolean);
}
async function ensureDailyRunsHeader(sheets, tab, prompts) {
  // create sheet if missing
  try { await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:B1` }); }
  catch {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] }
    });
  }
  // seed header
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1:B1`,
    valueInputOption: "RAW",
    requestBody: { values: [["prompt_id","prompt_text"]] }
  });
  // upsert rows A2:B
  if (prompts.length) {
    const body = prompts.map(p => [p.id, p.text]);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A2:B${prompts.length+1}`,
      valueInputOption: "RAW",
      requestBody: { values: body }
    });
  }
}
async function getOrCreateDateCols(sheets, tab, dateKey, wantWeb) {
  const hdr = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!1:1` });
  const header = hdr.data.values?.[0] || [];
  const need = [];
  const cols = {};
  const needCol = label => {
    const idx = header.indexOf(label);
    if (idx === -1) need.push(label); else cols[label] = idx + 1;
  };
  needCol(`${dateKey}_results_normal`);
  needCol(`${dateKey}_analysis_normal`);
  if (wantWeb) { needCol(`${dateKey}_results_web`); needCol(`${dateKey}_analysis_web`); }
  if (need.length) {
    const start = header.length + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tab}!${colNumToName(start)}1:${colNumToName(start+need.length-1)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [need] }
    });
    const hdr2 = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!1:1` });
    const header2 = hdr2.data.values?.[0] || [];
    for (const label of need) cols[label] = header2.indexOf(label) + 1;
  }
  return cols;
}

/** OpenAI calls */
async function callChat(model, promptText) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: "Answer concisely. Plain text only." },
        { role: "user", content: promptText }
      ]
    })
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}
async function callWeb(model, promptText) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: promptText,
      tools: [{ type: "web_search" }],
      temperature: 0.2,
      text: { format: { type: "text" }, verbosity: "medium" },
      tool_choice: "auto"
    })
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const data = await res.json();
  const txt = extractResponsesText(data);
  return sanitizeForSheet(txt);
}
function extractResponsesText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
  try {
    if (Array.isArray(data.output)) {
      const pieces = [];
      for (const item of data.output) {
        if (item && item.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c && typeof c.text === "string") pieces.push(c.text);
            if (c && c.type === "output_text" && typeof c.text === "string") pieces.push(c.text);
          }
        }
      }
      if (pieces.length) return pieces.join("\n\n");
    }
  } catch {}
  try {
    const c = data?.message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const t = c.map(x => x?.text).filter(Boolean).join("\n\n");
      if (t) return t;
    }
  } catch {}
  return "(no text extracted)";
}
function sanitizeForSheet(s) {
  if (!s) return "";
  return String(s).replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1").replace(/\s{2,}/g, " ").trim();
}

/** Vercel handler */
export default async function handler(req, res) {
  try {
    if (!OPENAI_API_KEY || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY || !SHEET_ID) {
      return res.status(400).json({ ok: false, error: "Missing env vars" });
    }
    const sheets = await sheetsClient();

    // 1) Settings
    const settings = await readSettings(sheets);
    const model = String(settings.model || DEFAULT_MODEL);
    const tabPrompts = String(settings.sheet_name_prompts || "Prompts");
    const tabBrands = String(settings.sheet_name_brands || "Brands");
    const tabWide = String(settings.sheet_name_wide || "Daily_Runs");
    const enableDual = String(settings.enable_dual_variant || "TRUE").toUpperCase() === "TRUE";
    const concurrency = Number(settings.chunk_size || 40) || 40; // reuse as concurrency limit

    // 2) Data
    const [prompts, brands] = await Promise.all([
      readPrompts(sheets, tabPrompts),
      readBrands(sheets, tabBrands)
    ]);
    const brandRegexes = brands.map(b => new RegExp(`\\b${escRegex(String(b))}\\b`, "i"));

    // 3) Ensure headers
    await ensureDailyRunsHeader(sheets, tabWide, prompts);
    const dateKey = todayKey("Africa/Cairo");
    const cols = await getOrCreateDateCols(sheets, tabWide, dateKey, enableDual);

    // 4) Run with concurrency
    const limit = pLimit(concurrency);
    const tasks = prompts.map((p, idx) => limit(async () => {
      const row = idx + 2; // row in Daily_Runs
      const out = {};

      const normalText = await safeTry(() => callChat(model, p.text));
      out.normal = normalText;
      out.normalAnalysis = analyzeText(normalText, brands, brandRegexes);

      if (enableDual) {
        const webText = await safeTry(() => callWeb(model, p.text));
        out.web = webText;
        out.webAnalysis = analyzeText(webText, brands, brandRegexes);
      }

      // write cells
      const updates = [];
      const put = (col, val) => updates.push({ range: `${tabWide}!${A1(row, col)}`, values: [[val]] });
      put(cols[`${dateKey}_results_normal`], out.normal);
      put(cols[`${dateKey}_analysis_normal`], out.normalAnalysis);
      if (enableDual) {
        put(cols[`${dateKey}_results_web`], out.web);
        put(cols[`${dateKey}_analysis_web`], out.webAnalysis);
      }

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: "RAW", data: updates }
      });
    }));

    await Promise.all(tasks);

    res.status(200).json({ ok: true, prompts: prompts.length, dateKey, model, enableDual, concurrency });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
}

/** small retry */
async function safeTry(fn, tries = 3) {
  let last = null;
  for (let i=0;i<tries;i++){
    try { return await fn(); }
    catch (e) {
      last = e;
      const code = extractCode(String(e));
      if (code === 429 || code >= 500) { await sleep(300 * Math.pow(2, i)); continue; }
      break;
    }
  }
  return `(error) ${String(last)}`;
}
function extractCode(msg){ const m = msg.match(/^(\d{3}):/); return m ? Number(m[1]) : 0; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
