// Vercel serverless function — stores the ranking in Redis (via the Upstash
// Marketplace integration) so it's shared across every device that plays.
// Reads credentials automatically from KV_REST_API_URL / KV_REST_API_TOKEN
// (or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) — whichever the
// integration injected, Redis.fromEnv() checks both.

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();
const KEY = 'milesimas:ranking';
const STORED_ENTRIES = 50; // how many we keep in Redis
const RETURNED_ENTRIES = 20; // how many we send back to the client

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const ranking = (await redis.get(KEY)) || [];
    res.status(200).json({ ranking: ranking.slice(0, RETURNED_ENTRIES) });
    return;
  }

  if (req.method === 'POST') {
    const { name, score, difficulty } = req.body || {};

    if (typeof name !== 'string' || !name.trim() || typeof score !== 'number') {
      res.status(400).json({ error: 'Faltan name o score válidos' });
      return;
    }

    const entry = {
      name: name.trim().slice(0, 24),
      score,
      difficulty: difficulty || null,
      date: new Date().toISOString(),
    };

    const current = (await redis.get(KEY)) || [];
    current.push(entry);
    current.sort((a, b) => b.score - a.score);
    const trimmed = current.slice(0, STORED_ENTRIES);

    await redis.set(KEY, trimmed);
    res.status(200).json({ ranking: trimmed.slice(0, RETURNED_ENTRIES) });
    return;
  }

  res.status(405).json({ error: 'Método no soportado' });
};
