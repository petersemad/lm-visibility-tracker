import { runGemini } from "@/lib/runGemini";

export default async function handler(req, res) {
  try {
    const output = await runGemini("Write one short sentence confirming Gemini works.");
    res.status(200).json({ ok: true, output });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
