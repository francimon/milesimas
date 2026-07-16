// Vercel serverless function — party rooms.
// POST (no ?code)  -> creates a party, returns { code }
// GET  ?code=XXXXX -> returns { config, ranking }
// POST ?code=XXXXX -> submits a score, returns { ranking }
//
// Parties expire after 24h (TTL in Redis) so old rooms don't pile up forever.

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();
const TTL_SECONDS = 60 * 60 * 24;
const STORED_ENTRIES = 50;
const RETURNED_ENTRIES = 20;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I, easy to read out loud

function generateCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

module.exports = async (req, res) => {
  const code = (req.query.code || '').toString().toUpperCase();

  // ---- Create a party ----
  if (req.method === 'POST' && !code) {
    const { entries, difficulty, rounds } = req.body || {};
    if (!Array.isArray(entries) || entries.length === 0) {
      res.status(400).json({ error: 'Faltan canciones para crear la party' });
      return;
    }

    const newCode = generateCode();
    await redis.set(
      `party:${newCode}:config`,
      { entries, difficulty, rounds, createdAt: Date.now() },
      { ex: TTL_SECONDS }
    );
    res.status(200).json({ code: newCode });
    return;
  }

  if (!code) {
    res.status(400).json({ error: 'Falta el código de la party' });
    return;
  }

  // ---- Join / view a party ----
  if (req.method === 'GET') {
    const config = await redis.get(`party:${code}:config`);
    if (!config) {
      res.status(404).json({ error: 'Party no encontrada o vencida' });
      return;
    }
    const ranking = (await redis.get(`party:${code}:ranking`)) || [];
    res.status(200).json({ config, ranking: ranking.slice(0, RETURNED_ENTRIES) });
    return;
  }

  // ---- Submit a score ----
  if (req.method === 'POST') {
    const { name, score } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || typeof score !== 'number') {
      res.status(400).json({ error: 'Faltan name o score válidos' });
      return;
    }

    const config = await redis.get(`party:${code}:config`);
    if (!config) {
      res.status(404).json({ error: 'Party no encontrada o vencida' });
      return;
    }

    const cleanName = name.trim().slice(0, 24);
    const current = (await redis.get(`party:${code}:ranking`)) || [];

    // Keep each player's best score, not every attempt.
    const idx = current.findIndex(e => e.name === cleanName);
    const candidate = { name: cleanName, score, date: new Date().toISOString() };
    if (idx >= 0) {
      if (score > current[idx].score) current[idx] = candidate;
    } else {
      current.push(candidate);
    }
    current.sort((a, b) => b.score - a.score);
    const trimmed = current.slice(0, STORED_ENTRIES);

    await redis.set(`party:${code}:ranking`, trimmed, { ex: TTL_SECONDS });
    res.status(200).json({ ranking: trimmed.slice(0, RETURNED_ENTRIES) });
    return;
  }

  res.status(405).json({ error: 'Método no soportado' });
};
