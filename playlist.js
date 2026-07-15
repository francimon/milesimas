// Vercel serverless function — runs on the server, never in the browser.
// Requires two environment variables set in the Vercel project settings:
//   SPOTIFY_CLIENT_ID
//   SPOTIFY_CLIENT_SECRET
// Get them from https://developer.spotify.com/dashboard (Client Credentials flow
// doesn't need a working redirect URI — any placeholder value is fine there).

module.exports = async (req, res) => {
  const { playlistId } = req.query;

  if (!playlistId) {
    res.status(400).json({ error: 'Falta el parámetro playlistId' });
    return;
  }

  try {
    const id = extractPlaylistId(playlistId);
    const token = await getSpotifyToken();
    const tracks = await getAllPlaylistTracks(id, token);
    res.status(200).json({ tracks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo leer la playlist de Spotify' });
  }
};

function extractPlaylistId(input) {
  const match = input.match(/playlist[/:]([a-zA-Z0-9]+)/);
  return match ? match[1] : input.trim();
}

async function getSpotifyToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Faltan SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET');

  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!resp.ok) throw new Error('No se pudo autenticar con Spotify');
  const data = await resp.json();
  return data.access_token;
}

async function getAllPlaylistTracks(playlistId, token) {
  const tracks = [];
  let url =
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks` +
    `?limit=100&fields=next,items(track(name,artists(name)))`;

  while (url) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error('No se pudo leer los tracks de la playlist');
    const data = await resp.json();

    for (const item of data.items) {
      if (!item.track) continue; // tracks removed from Spotify show up as null
      tracks.push({
        name: item.track.name,
        artist: item.track.artists.map(a => a.name).join(', '),
      });
    }
    url = data.next;
  }
  return tracks;
}
