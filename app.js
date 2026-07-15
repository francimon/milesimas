// ---------- Config ----------

const DURATIONS_MS = {
  facil:   [500, 2000, 10000],
  normal:  [500, 1000, 5000],
  dificil: [300, 800, 3000],
};

const SCORES = {
  facil:   [100, 50, 20],
  normal:  [150, 75, 30],
  dificil: [200, 100, 40],
};

const WAVEFORM_BARS = 48;

// ---------- State ----------

const state = {
  difficulty: 'normal',
  totalRounds: 5,
  playerName: '',
  library: [],       // { id, name, artist, previewUrl, artworkUrl, audioBuffer }
  playedIds: [],
  roundIndex: 0,
  currentTrack: null,
  currentTier: 0,    // 0, 1, 2
  startOffsetSec: 0,
  waveformLevels: [],
  score: 0,
  selectedGuessId: null,
  audioCtx: null,
  spotifyEntries: null, // filled in after picking a playlist, { name, artist }[]
  spotifyAccessToken: null,
  spotifyPlaylists: [],
};

// ---------- DOM refs ----------

const screens = {
  setup: document.getElementById('screen-setup'),
  loading: document.getElementById('screen-loading'),
  game: document.getElementById('screen-game'),
  end: document.getElementById('screen-end'),
};

const el = {
  setupForm: document.getElementById('setup-form'),
  trackList: document.getElementById('track-list'),
  rounds: document.getElementById('rounds'),
  playerName: document.getElementById('player-name'),
  setupError: document.getElementById('setup-error'),
  spotifyLoggedOut: document.getElementById('spotify-logged-out'),
  spotifyLoggedIn: document.getElementById('spotify-logged-in'),
  spotifyLoginBtn: document.getElementById('spotify-login-btn'),
  spotifyPlaylistSelect: document.getElementById('spotify-playlist-select'),
  loadPlaylistBtn: document.getElementById('load-playlist-btn'),
  spotifyStatus: document.getElementById('spotify-status'),

  progressFill: document.getElementById('progress-fill'),
  progressCount: document.getElementById('progress-count'),

  roundCounter: document.getElementById('round-counter'),
  scoreDisplay: document.getElementById('score-display'),
  waveform: document.getElementById('waveform'),
  tierReadout: document.getElementById('tier-readout'),
  playBtn: document.getElementById('play-btn'),
  guessInput: document.getElementById('guess-input'),
  suggestions: document.getElementById('suggestions'),
  confirmBtn: document.getElementById('confirm-btn'),
  skipBtn: document.getElementById('skip-btn'),
  feedback: document.getElementById('feedback'),

  endName: document.getElementById('end-name'),
  endScore: document.getElementById('end-score'),
  rankingList: document.getElementById('ranking-list'),
  playAgainBtn: document.getElementById('play-again-btn'),
};

function showScreen(name) {
  Object.entries(screens).forEach(([key, node]) => {
    node.hidden = key !== name;
  });
}

// ---------- Helpers ----------

function normalize(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function parseTrackList(raw) {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split(/\s+-\s+/);
      if (parts.length < 2) return { name: line.trim(), artist: '' };
      const artist = parts.pop().trim();
      const name = parts.join(' - ').trim();
      return { name, artist };
    });
}

function getAudioCtx() {
  if (!state.audioCtx) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return state.audioCtx;
}

// ---------- Setup screen: Spotify vs manual tabs ----------

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    document.querySelectorAll('[data-panel]').forEach(p => {
      p.hidden = p.id !== `tab-${tab.dataset.tab}`;
    });
  });
});

// ---------- Spotify login (Authorization Code + PKCE) ----------
//
// PKCE doesn't need a client secret, so this whole flow — including reading
// the playlist's tracks — happens directly in the browser. Fill in your own
// Client ID below (it's public info, safe to ship in client-side code), and
// register SPOTIFY_REDIRECT_URI as a Redirect URI in your Spotify dashboard
// (Settings) exactly as it appears once deployed.

const SPOTIFY_CLIENT_ID = 'afef91a1d7be4f6eac409ef86eacb001'; // <- reemplazar
const SPOTIFY_REDIRECT_URI = window.location.origin + window.location.pathname;
const SPOTIFY_SCOPES = 'playlist-read-private playlist-read-collaborative';

function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values).map(v => chars[v % chars.length]).join('');
}

async function sha256(plain) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain));
}

el.spotifyLoginBtn.addEventListener('click', async () => {
  const verifier = generateRandomString(64);
  const challenge = base64UrlEncode(await sha256(verifier));
  const oauthState = generateRandomString(16);

  // The redirect to Spotify is a full page navigation, so JS memory is lost —
  // sessionStorage is what survives the round trip (this only runs once the
  // site is deployed on a real https domain, not from a local file).
  sessionStorage.setItem('spotify_verifier', verifier);
  sessionStorage.setItem('spotify_oauth_state', oauthState);

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SPOTIFY_SCOPES,
    state: oauthState,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
});

async function handleSpotifyRedirect() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  if (!code) return;

  const expectedState = sessionStorage.getItem('spotify_oauth_state');
  const verifier = sessionStorage.getItem('spotify_verifier');
  window.history.replaceState({}, '', window.location.pathname);

  if (!verifier || urlParams.get('state') !== expectedState) {
    el.spotifyStatus.textContent = 'No pudimos validar el login con Spotify, probá de nuevo.';
    return;
  }

  el.spotifyStatus.textContent = 'Conectando con Spotify…';
  try {
    const tokenResp = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SPOTIFY_CLIENT_ID,
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
    if (!tokenResp.ok) throw new Error('token-exchange-failed');
    const tokenData = await tokenResp.json();
    state.spotifyAccessToken = tokenData.access_token;
    await loadSpotifyPlaylists();
  } catch (err) {
    console.error(err);
    el.spotifyStatus.textContent = 'Falló la conexión con Spotify. Revisá que el Client ID y el Redirect URI coincidan con los de tu dashboard.';
  }
}

async function fetchAllPages(url, token) {
  let items = [];
  let nextUrl = url;
  while (nextUrl) {
    const resp = await fetch(nextUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error('spotify-fetch-failed');
    const data = await resp.json();
    items = items.concat(data.items || []);
    nextUrl = data.next;
  }
  return items;
}

async function loadSpotifyPlaylists() {
  el.spotifyLoggedOut.hidden = true;
  el.spotifyLoggedIn.hidden = false;
  el.spotifyStatus.textContent = 'Cargando tus playlists…';

  try {
    const playlists = await fetchAllPages('https://api.spotify.com/v1/me/playlists?limit=50', state.spotifyAccessToken);
    state.spotifyPlaylists = playlists;
    el.spotifyPlaylistSelect.innerHTML = playlists
      .map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
      .join('');
    el.spotifyStatus.textContent = playlists.length
      ? `${playlists.length} playlists encontradas.`
      : 'No encontramos playlists propias en tu cuenta.';
  } catch (err) {
    console.error(err);
    el.spotifyStatus.textContent = 'No pudimos cargar tus playlists.';
  }
}

el.loadPlaylistBtn.addEventListener('click', async () => {
  const playlistId = el.spotifyPlaylistSelect.value;
  if (!playlistId) return;

  el.spotifyStatus.textContent = 'Leyendo canciones de la playlist…';
  el.loadPlaylistBtn.disabled = true;
  try {
    const rawItems = await fetchAllPages(
      `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=50&fields=next,items(item(name,artists(name)))`,
      state.spotifyAccessToken
    );
    const entries = rawItems
      .map(entry => entry.item)
      .filter(Boolean)
      .map(item => ({ name: item.name, artist: (item.artists || []).map(a => a.name).join(', ') }));

    state.spotifyEntries = entries;
    el.spotifyStatus.textContent = entries.length
      ? `${entries.length} canciones cargadas de la playlist.`
      : 'Esta playlist no tiene canciones, o no sos dueño/colaborador de ella.';
  } catch (err) {
    console.error(err);
    state.spotifyEntries = null;
    el.spotifyStatus.textContent = 'No pudimos leer esta playlist (¿sos dueño o colaborador?).';
  } finally {
    el.loadPlaylistBtn.disabled = false;
  }
});

handleSpotifyRedirect();

function getSelectedTrackEntries() {
  const activeTab = document.querySelector('.tab.active').dataset.tab;
  if (activeTab === 'spotify') return state.spotifyEntries || [];
  return parseTrackList(el.trackList.value);
}

// ---------- Setup screen: submit ----------

el.setupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.setupError.hidden = true;

  const entries = getSelectedTrackEntries();
  const rounds = parseInt(el.rounds.value, 10) || 1;
  const name = el.playerName.value.trim();

  if (entries.length === 0) {
    const activeTab = document.querySelector('.tab.active').dataset.tab;
    return showSetupError(
      activeTab === 'spotify'
        ? 'Primero buscá una playlist con el botón "Buscar".'
        : 'Pegá al menos una canción, una por línea.'
    );
  }
  if (!name) {
    return showSetupError('Ingresá tu nombre.');
  }

  state.difficulty = el.setupForm.querySelector('input[name="difficulty"]:checked').value;
  state.totalRounds = rounds;
  state.playerName = name;

  // Creating the AudioContext here, inside a real click/submit, keeps browsers happy
  getAudioCtx();

  showScreen('loading');
  await loadLibrary(entries);

  if (state.library.length === 0) {
    showScreen('setup');
    return showSetupError('No encontramos audio para ninguna de esas canciones. Probá con otros nombres.');
  }

  if (state.library.length < state.totalRounds) {
    state.totalRounds = state.library.length;
  }

  state.roundIndex = 0;
  state.score = 0;
  state.playedIds = [];
  startRound();
});

function showSetupError(msg) {
  el.setupError.textContent = msg;
  el.setupError.hidden = false;
}

// ---------- Loading previews from iTunes ----------

async function fetchPreview(entry) {
  const term = encodeURIComponent(`${entry.name} ${entry.artist}`.trim());
  const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=1`;
  const res = await fetch(url);
  const data = await res.json();
  const hit = data.results && data.results[0];
  if (!hit || !hit.previewUrl) return null;
  return {
    previewUrl: hit.previewUrl,
    artworkUrl: hit.artworkUrl100,
    // Keep the name/artist the player typed in — that's the answer we'll grade against.
    name: entry.name,
    artist: entry.artist || hit.artistName,
  };
}

async function decodeBuffer(url) {
  const res = await fetch(url);
  const arrayBuffer = await res.arrayBuffer();
  return getAudioCtx().decodeAudioData(arrayBuffer);
}

async function loadLibrary(entries) {
  state.library = [];
  el.progressCount.textContent = `0 / ${entries.length}`;
  el.progressFill.style.width = '0%';

  for (let i = 0; i < entries.length; i++) {
    try {
      const found = await fetchPreview(entries[i]);
      if (found) {
        const audioBuffer = await decodeBuffer(found.previewUrl);
        state.library.push({
          id: `t${i}`,
          name: found.name,
          artist: found.artist,
          previewUrl: found.previewUrl,
          artworkUrl: found.artworkUrl,
          audioBuffer,
        });
      }
    } catch (err) {
      console.error('No se pudo cargar', entries[i], err);
    }
    el.progressCount.textContent = `${i + 1} / ${entries.length}`;
    el.progressFill.style.width = `${((i + 1) / entries.length) * 100}%`;
  }
}

// ---------- Game round ----------

function startRound() {
  const remaining = state.library.filter(t => !state.playedIds.includes(t.id));
  const track = remaining[Math.floor(Math.random() * remaining.length)];
  state.currentTrack = track;
  state.playedIds.push(track.id);
  state.currentTier = 0;
  state.selectedGuessId = null;

  const maxDurationSec = DURATIONS_MS[state.difficulty][2] / 1000;
  const dur = track.audioBuffer.duration;
  state.startOffsetSec = dur > maxDurationSec + 1
    ? Math.random() * (dur - maxDurationSec - 1)
    : 0;

  state.waveformLevels = computeWaveform(track.audioBuffer, state.startOffsetSec, maxDurationSec);
  renderWaveform();

  el.guessInput.value = '';
  el.suggestions.hidden = true;
  el.confirmBtn.disabled = true;
  el.feedback.textContent = '';
  el.feedback.className = 'feedback';

  updateHud();
  showScreen('game');
}

function updateHud() {
  el.roundCounter.textContent = `Canción ${state.roundIndex + 1} de ${state.totalRounds}`;
  el.scoreDisplay.textContent = `${state.score} pts`;
  el.tierReadout.textContent = `${(DURATIONS_MS[state.difficulty][state.currentTier] / 1000).toFixed(3)}s`;
  updateWaveformReveal();
}

function computeWaveform(buffer, startSec, windowSec, barCount = WAVEFORM_BARS) {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const startSample = Math.floor(startSec * sr);
  const windowSamples = Math.floor(windowSec * sr);
  const step = Math.max(1, Math.floor(windowSamples / barCount));
  const bars = [];
  for (let i = 0; i < barCount; i++) {
    const from = startSample + i * step;
    const to = Math.min(from + step, startSample + windowSamples, data.length);
    let sum = 0, count = 0;
    for (let j = from; j < to; j++) { sum += Math.abs(data[j]); count++; }
    bars.push(count ? sum / count : 0);
  }
  const max = Math.max(...bars, 0.0001);
  return bars.map(v => v / max);
}

function renderWaveform() {
  el.waveform.innerHTML = '';
  state.waveformLevels.forEach(() => {
    const bar = document.createElement('div');
    bar.className = 'bar';
    el.waveform.appendChild(bar);
  });
  updateWaveformReveal();
}

function updateWaveformReveal() {
  const maxDurationMs = DURATIONS_MS[state.difficulty][2];
  const tierMs = DURATIONS_MS[state.difficulty][state.currentTier];
  const activeCount = Math.max(1, Math.round(WAVEFORM_BARS * (tierMs / maxDurationMs)));
  const bars = el.waveform.children;
  for (let i = 0; i < bars.length; i++) {
    const level = state.waveformLevels[i];
    bars[i].style.height = `${Math.max(6, level * 72)}px`;
    bars[i].classList.toggle('active', i < activeCount);
  }
}

// ---------- Playback ----------

el.playBtn.addEventListener('click', () => {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();

  const track = state.currentTrack;
  const durationSec = DURATIONS_MS[state.difficulty][state.currentTier] / 1000;

  const source = ctx.createBufferSource();
  source.buffer = track.audioBuffer;
  source.connect(ctx.destination);
  source.start(0, state.startOffsetSec, durationSec);

  el.playBtn.classList.add('playing');
  setTimeout(() => el.playBtn.classList.remove('playing'), durationSec * 1000);
});

// ---------- Guessing (autocomplete, no free typing needed) ----------

el.guessInput.addEventListener('input', () => {
  state.selectedGuessId = null;
  el.confirmBtn.disabled = true;

  const q = normalize(el.guessInput.value);
  if (!q) { el.suggestions.hidden = true; return; }

  const matches = state.library.filter(t =>
    normalize(`${t.name} ${t.artist}`).includes(q)
  ).slice(0, 8);

  renderSuggestions(matches);
});

function renderSuggestions(matches) {
  el.suggestions.innerHTML = '';
  if (matches.length === 0) { el.suggestions.hidden = true; return; }

  matches.forEach(track => {
    const li = document.createElement('li');
    li.innerHTML = `${escapeHtml(track.name)} <span class="artist">— ${escapeHtml(track.artist)}</span>`;
    li.addEventListener('click', () => selectGuess(track));
    el.suggestions.appendChild(li);
  });
  el.suggestions.hidden = false;
}

function selectGuess(track) {
  state.selectedGuessId = track.id;
  el.guessInput.value = `${track.name} — ${track.artist}`;
  el.suggestions.hidden = true;
  el.confirmBtn.disabled = false;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

document.addEventListener('click', (e) => {
  if (!el.suggestions.contains(e.target) && e.target !== el.guessInput) {
    el.suggestions.hidden = true;
  }
});

el.confirmBtn.addEventListener('click', () => {
  if (!state.selectedGuessId) return;
  if (state.selectedGuessId === state.currentTrack.id) {
    resolveRound(true);
  } else {
    resolveRound(false);
  }
});

el.skipBtn.addEventListener('click', () => resolveRound(false));

function resolveRound(correct) {
  if (correct) {
    const points = SCORES[state.difficulty][state.currentTier];
    state.score += points;
    el.feedback.textContent = `¡Correcto! +${points} pts`;
    el.feedback.className = 'feedback correct';
    setTimeout(advanceToNextRoundOrTrack, 900);
    return;
  }

  if (state.currentTier < 2) {
    state.currentTier += 1;
    el.guessInput.value = '';
    el.confirmBtn.disabled = true;
    el.feedback.textContent = 'Pasaste al siguiente fragmento.';
    el.feedback.className = 'feedback';
    updateHud();
  } else {
    el.feedback.textContent = `Era "${state.currentTrack.name} — ${state.currentTrack.artist}"`;
    el.feedback.className = 'feedback wrong';
    setTimeout(advanceToNextRoundOrTrack, 1400);
  }
}

function advanceToNextRoundOrTrack() {
  state.roundIndex += 1;
  if (state.roundIndex >= state.totalRounds) {
    endGame();
  } else {
    startRound();
  }
}

// ---------- End screen ----------

async function endGame() {
  el.endName.textContent = state.playerName;
  el.endScore.textContent = state.score;
  el.rankingList.innerHTML = '<li>Guardando puntaje…</li>';
  showScreen('end');

  try {
    const resp = await fetch('/api/ranking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: state.playerName,
        score: state.score,
        difficulty: state.difficulty,
      }),
    });
    if (!resp.ok) throw new Error('ranking-post-failed');
    const data = await resp.json();
    renderRanking(data.ranking);
  } catch (err) {
    console.error(err);
    el.rankingList.innerHTML = '';
    const li = document.createElement('li');
    li.textContent = 'No pudimos conectar con el ranking compartido (¿ya está la base de datos conectada en Vercel?).';
    el.rankingList.appendChild(li);
  }
}

function renderRanking(ranking) {
  el.rankingList.innerHTML = '';
  ranking.forEach(item => {
    const li = document.createElement('li');
    if (item.name === state.playerName && item.score === state.score) {
      li.classList.add('you');
    }
    li.innerHTML = `<span>${escapeHtml(item.name)}</span><span>${item.score} pts</span>`;
    el.rankingList.appendChild(li);
  });
}

el.playAgainBtn.addEventListener('click', () => {
  showScreen('setup');
});
