import { runTracker } from './run.js';

export default async function handler(req, res) {
  try {
    await runTracker();
    res.status(200).json({ ok: true, message: "Run complete, check your Google Sheet" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
}
