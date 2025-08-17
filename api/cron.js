export default async function handler(req, res) {
  // Protect with secret
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // For now, just test
    console.log("Cron job ran at", new Date().toISOString());
    res.status(200).json({ ok: true, time: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
