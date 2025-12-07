import { runGemini } from "../lib/runGemini.js"; // adjust path if needed

export default async function handler(req, res) {
  try {
    const output = await runGemini("Write one short sentence confirming Gemini works.");
    res.status(200).json({ ok: true, output });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || "Unknown error" });
  }
}
