// Vercel serverless function — party rooms with a shared song pool.
//
// POST  (no ?code)              -> creates a party with a big shared pool, returns { code }
// POST  ?code=XXXXX&action=join -> atomically claims the next chunk of songs from
//                                  the pool for this player, returns { entries, difficulty, lives }
// GET   ?code=XXXXX             -> returns just the ranking (used by "actualizar")
// POST  ?code=XXXXX             -> submits a score, returns { ranking }
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
  const action = (req.query.action || '').toString();

  // ---- Create a party ----
  if (req.method === 'POST' && !code) {
    const { pool, difficulty, rounds, lives } = req.body || {};
    if (!Array.isArray(pool) || pool.length === 0) {
      res.status(400).json({ error: 'Faltan canciones para crear la party' });
      return;
    }
    if (!rounds || rounds < 1) {
      res.status(400).json({ error: 'Falta la cantidad de canciones por jugador' });
      return;
    }

    const cleanLives = (typeof lives === 'number' && lives > 0) ? lives : null; // null = unlimited

    const newCode = generateCode();
    await redis.set(
      `party:${newCode}:config`,
      { pool, difficulty, rounds, lives: cleanLives, createdAt: Date.now() },
      { ex: TTL_SECONDS }
    );
    res.status(200).json({ code: newCode, poolSize: pool.length });
    return;
  }

  if (!code) {
    res.status(400).json({ error: 'Falta el código de la party' });
    return;
  }

  // ---- Join: atomically claim the next chunk of songs from the shared pool ----
  if (req.method === 'POST' && action === 'join') {
    const config = await redis.get(`party:${code}:config`);
    if (!config) {
      res.status(404).json({ error: 'Party no encontrada o vencida' });
      return;
    }

    const rounds = config.rounds;
    const poolSize = config.pool.length;
    const claimedKey = `party:${code}:claimed`;

    // INCRBY is atomic in Redis, so two people joining at the same instant
    // still get different, non-overlapping ranges.
    const newCount = await redis.incrby(claimedKey, rounds);
    await redis.expire(claimedKey, TTL_SECONDS);

    const startIdx = (newCount - rounds) % poolSize;
    const entries = [];
    for (let i = 0; i < rounds; i++) {
      entries.push(config.pool[(startIdx + i) % poolSize]);
    }

    res.status(200).json({
      entries,
      difficulty: config.difficulty,
      lives: config.lives, // null means unlimited
      recycled: newCount > poolSize, // true once the pool has wrapped around
    });
    return;
  }

  // ---- View the ranking only (used by the "actualizar" refresh button) ----
  if (req.method === 'GET') {
    const config = await redis.get(`party:${code}:config`);
    if (!config) {
      res.status(404).json({ error: 'Party no encontrada o vencida' });
      return;
    }
    const ranking = (await redis.get(`party:${code}:ranking`)) || [];
    res.status(200).json({ ranking: ranking.slice(0, RETURNED_ENTRIES) });
    return;
  }

  // ---- Submit a score (keeps each player's best attempt) ----
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
