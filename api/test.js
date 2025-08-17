import { google } from "googleapis";

const { GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY: RAW, SHEET_ID } = process.env;
const GOOGLE_PRIVATE_KEY = RAW?.includes("\\n") ? RAW.replace(/\\n/g, "\n") : RAW;

async function sheetsClient() {
  const auth = new google.auth.JWT(
    GOOGLE_CLIENT_EMAIL,
    null,
    GOOGLE_PRIVATE_KEY,
    ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  );
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

export default async function handler(req, res) {
  try {
    const sheets = await sheetsClient();
    const out = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Settings!A1:B"
    });
    res.status(200).json({ ok: true, values: out.data.values || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
