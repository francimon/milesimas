// Vercel serverless function — proxies Deezer's search API.
// Deezer doesn't allow direct browser fetch (no CORS headers), so this
// exists purely to get around that. Used as a fallback when iTunes doesn't
// have a good match for a song.

module.exports = async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) {
    res.status(400).json({ error: 'Falta el parámetro q' });
    return;
  }

  try {
    const resp = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=1`);
    if (!resp.ok) throw new Error('deezer-search-failed');
    const data = await resp.json();
    const hit = data.data && data.data[0];

    if (!hit || !hit.preview) {
      res.status(200).json({ found: false });
      return;
    }

    res.status(200).json({
      found: true,
      previewUrl: hit.preview,
      foundName: hit.title,
      foundArtist: hit.artist ? hit.artist.name : '',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No pudimos buscar en Deezer' });
  }
};
