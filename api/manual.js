import { google } from "googleapis";

/* ===== ENV ===== */
const {
  OPENAI_API_KEY,
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY: RAW_KEY,
  SHEET_ID,
  DEFAULT_MODEL = "gpt-4o"
} = process.env;

const GOOGLE_PRIVATE_KEY = RAW_KEY?.includes("\\n") ? RAW_KEY.replace(/\\n/g, "\n") : RAW_KEY;

/* ===== Small utils ===== */
const A1 = (r, c) => `${colName(c)}${r}`;
function colName(n) { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function todayKey(tz = "Africa/Cairo") { const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); return f.format(new Date()); }
function escRegex(s) { return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"); }
function sanitizeForSheet(s) { if (!s) return ""; return String(s).replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1").replace(/\s{2,}/g, " ").trim(); }
function analyzeText(txt, brands, brandRegexes) {
  if (!txt) return "SC=No | Brands=";
  const sc = /(?:\bSales\s*Captain\b|salescaptain)/i.test(txt);
  const hits = [];
  for (let i = 0; i < brandRegexes.length; i++) {
    const b = brands[i];
    if (/^Sales\s*Captain$/i.test(b)) continue;
    if (brandRegexes[i].test(txt)) hits.push(b);
  }
  return `SC=${sc ? "Yes" : "No"} | Brands=${hits.join(", ")}`;
}

/* ===== Google Sheets client ===== */
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

/* ===== Sheet IO ===== */
async function readSettings(sheets, tab = "Settings") {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:B` });
  const rows = r.data.values || [];
  const map = {};
  rows.forEach(x => { if (x[0]) map[String(x[0]).trim()] = x[1]; });
  return map;
}
async function readPrompts(sheets, tab) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A2:C` });
  const rows = r.data.values || [];
  return rows
    .map(x => ({ id: x[0]?.trim(), text: x[1]?.trim(), enabled: String(x[2]).toUpperCase() === "TRUE" }))
    .filter(x => x.id && x.text && x.enabled);
}
async function readBrands(sheets, tab) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A2:A` });
  return (r.data.values || []).flat().filter(Boolean);
}
async function ensureDailyRunsHeader(sheets, tab, prompts) {
  // create sheet if missing
  try {
    await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:B1` });
  } catch {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] }
    });
  }
  // set header
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1:B1`,
    valueInputOption: "RAW",
    requestBody: { values: [["prompt_id", "prompt_text"]] }
  });
  // upsert rows A2:B
  if (prompts.length) {
    const body = prompts.map(p => [p.id, p.text]);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A2:B${prompts.length + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: body }
    });
  }
}
async function getOrCreateDateCols(sheets, tab, dateKey, wantWeb) {
  const hdr = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!1:1` });
  const header = hdr.data.values?.[0] || [];
  const cols = {};
  const need = [];
  function needCol(label) {
    const i = header.indexOf(label);
    if (i === -1) need.push(label);
    else cols[label] = i + 1;
  }
  needCol(`${dateKey}_results_normal`);
  needCol(`${dateKey}_analysis_normal`);
  if (wantWeb) { needCol(`${dateKey}_results_web`); needCol(`${dateKey}_analysis_web`); }
  if (need.length) {
    const start = header.length + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tab}!${colName(start)}1:${colName(start + need.length - 1)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [need] }
    });
    const hdr2 = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!1:1` });
    const h2 = hdr2.data.values?.[0] || [];
    need.forEach(label => { cols[label] = h2.indexOf(label) + 1; });
  }
  return cols;
}

/* ===== OpenAI calls ===== */
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
      const parts = [];
      for (const item of data.output) {
        if (item?.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (typeof c?.text === "string") parts.push(c.text);
            if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
          }
        }
      }
      if (parts.length) return parts.join("\n\n");
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

/* ===== Handler - run once, no auth, respects Settings ===== */
export default async function handler(req, res) {
  try {
    // sanity check envs
    for (const k of ["OPENAI_API_KEY","GOOGLE_CLIENT_EMAIL","GOOGLE_PRIVATE_KEY","SHEET_ID"]) {
      if (!process.env[k]) return res.status(400).json({ ok:false, error:`Missing env ${k}` });
    }
    const sheets = await sheetsClient();

    // 1) settings
    const settings = await readSettings(sheets, "Settings");
    const model = String(settings.model || DEFAULT_MODEL);
    const tabPrompts = String(settings.sheet_name_prompts || "Prompts");
    const tabBrands = String(settings.sheet_name_brands || "Brands");
    const tabWide = String(settings.sheet_name_wide || "Daily_Runs");
    const enableDual = String(settings.enable_dual_variant || "TRUE").toUpperCase() === "TRUE";
    const concurrency = Number(settings.chunk_size || 20) || 20; // used as parallelism

    // 2) data
    const [prompts, brands] = await Promise.all([
      readPrompts(sheets, tabPrompts),
      readBrands(sheets, tabBrands)
    ]);
    if (!prompts.length) {
      return res.status(200).json({ ok:true, message:"No enabled prompts" });
    }
    const brandRegexes = brands.map(b => new RegExp(`\\b${escRegex(String(b))}\\b`, "i"));

    // 3) prepare wide sheet
    await ensureDailyRunsHeader(sheets, tabWide, prompts);
    const dateKey = todayKey("Africa/Cairo");
    const cols = await getOrCreateDateCols(sheets, tabWide, dateKey, enableDual);

    // 4) run with a simple pool
    let i = 0, active = 0, done = 0, errors = [];
    const next = () => i < prompts.length ? i++ : -1;

    await new Promise(resolve => {
      const runOne = async () => {
        const idx = next();
        if (idx === -1) { if (active === 0) resolve(); return; }
        active++;
        const p = prompts[idx];
        const row = idx + 2;
        try {
          const normal = await callChat(model, p.text);
          const normalA = analyzeText(normal, brands, brandRegexes);

          let web = "", webA = "";
          if (enableDual) {
            try { web = await callWeb(model, p.text); }
            catch (e) { web = `(error web) ${String(e)}`; }
            webA = analyzeText(web, brands, brandRegexes);
          }

          const updates = [];
          const put = (c, v) => updates.push({ range: `${tabWide}!${A1(row, c)}`, values: [[v]] });
          put(cols[`${dateKey}_results_normal`], normal);
          put(cols[`${dateKey}_analysis_normal`], normalA);
          if (enableDual) {
            put(cols[`${dateKey}_results_web`], web);
            put(cols[`${dateKey}_analysis_web`], webA);
          }

          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: SHEET_ID,
            requestBody: { valueInputOption: "RAW", data: updates }
          });
          done++;
        } catch (e) { errors.push(String(e)); }
        finally { active--; runOne(); }
      };

      const N = Math.max(1, Math.min(concurrency, prompts.length));
      for (let k = 0; k < N; k++) runOne();
    });

    return res.status(200).json({ ok:true, model, dual:enableDual, prompts:prompts.length, processed: done, errors });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
}
