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
const PARTY_POOL_CAP = 60; // max songs resolved into a party's shared pool

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
  partyCode: null,        // set once you're playing inside a party
  pendingPartyCode: null, // set while the join banner is showing, before you hit "join"
  partyLivesMax: null,    // max total plays allowed per person in this party (null = unlimited)
  partyLivesUsed: 0,      // how many of those this person has used so far
};

// ---------- DOM refs ----------

const screens = {
  setup: document.getElementById('screen-setup'),
  loading: document.getElementById('screen-loading'),
  game: document.getElementById('screen-game'),
  end: document.getElementById('screen-end'),
  partyCreated: document.getElementById('screen-party-created'),
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
  viewRankingBtn: document.getElementById('view-ranking-btn'),
  setupRankingList: document.getElementById('setup-ranking-list'),
  resetRankingBtn: document.getElementById('reset-ranking-btn'),
  resetRankingStatus: document.getElementById('reset-ranking-status'),

  loadingLog: document.getElementById('loading-log'),

  partyRounds: document.getElementById('party-rounds'),
  partyLives: document.getElementById('party-lives'),
  partyJoinBanner: document.getElementById('party-join-banner'),
  partyCodeLabel: document.getElementById('party-code-label'),
  partyPlayerName: document.getElementById('party-player-name'),
  joinPartyBtn: document.getElementById('join-party-btn'),
  partyJoinStatus: document.getElementById('party-join-status'),
  createPartyBtn: document.getElementById('create-party-btn'),
  partyShareLink: document.getElementById('party-share-link'),
  partyShareCode: document.getElementById('party-share-code'),
  copyPartyLinkBtn: document.getElementById('copy-party-link-btn'),
  startPartyGameBtn: document.getElementById('start-party-game-btn'),
  partyCreatedError: document.getElementById('party-created-error'),
  refreshPartyRankingBtn: document.getElementById('refresh-party-ranking-btn'),
  partyLivesHint: document.getElementById('party-lives-hint'),

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

const SPOTIFY_CLIENT_ID = 'afef91a1d7be4f6eac409ef86eacb001';
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

async function loadPlaylistTracks(playlistId, triggerBtn) {
  if (!playlistId) return;
  el.spotifyStatus.textContent = 'Leyendo canciones de la playlist…';
  if (triggerBtn) triggerBtn.disabled = true;

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
    el.spotifyStatus.textContent = 'No pudimos leer esta playlist. Solo funciona si sos dueño o colaborador de ella.';
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
  }
}

el.loadPlaylistBtn.addEventListener('click', () => {
  loadPlaylistTracks(el.spotifyPlaylistSelect.value, el.loadPlaylistBtn);
});

handleSpotifyRedirect();

function getSelectedTrackEntries() {
  const activeTab = document.querySelector('.tab.active').dataset.tab;
  if (activeTab === 'spotify') return state.spotifyEntries || [];
  return parseTrackList(el.trackList.value);
}

// ---------- Setup screen: submit ----------

const MANUAL_LIST_STORAGE_KEY = 'milesimas_manual_list';

try {
  const savedList = localStorage.getItem(MANUAL_LIST_STORAGE_KEY);
  if (savedList) el.trackList.value = savedList;
} catch (err) {
  // Storage can be blocked (private browsing, etc.) — the game still works, it just won't remember.
}

el.trackList.addEventListener('input', () => {
  try {
    localStorage.setItem(MANUAL_LIST_STORAGE_KEY, el.trackList.value);
  } catch (err) {
    // Ignore — non-critical.
  }
});

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
  state.partyCode = null;

  // Creating the AudioContext here, inside a real click/submit, keeps browsers happy
  getAudioCtx();

  showScreen('loading');
  await loadLibrary(entries, rounds);

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

el.viewRankingBtn.addEventListener('click', async () => {
  const list = el.setupRankingList;
  if (!list.hidden) {
    list.hidden = true;
    el.resetRankingBtn.hidden = true;
    return;
  }

  list.hidden = false;
  el.resetRankingBtn.hidden = false;
  list.innerHTML = '<li>Cargando…</li>';
  try {
    const resp = await fetch('/api/ranking');
    if (!resp.ok) throw new Error('ranking-get-failed');
    const data = await resp.json();
    list.innerHTML = '';
    if (!data.ranking || data.ranking.length === 0) {
      list.innerHTML = '<li>Todavía no hay puntajes guardados.</li>';
      return;
    }
    data.ranking.forEach(item => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(item.name)}</span><span>${item.score} pts</span>`;
      list.appendChild(li);
    });
  } catch (err) {
    console.error(err);
    list.innerHTML = '<li>No pudimos cargar el ranking.</li>';
  }
});

el.resetRankingBtn.addEventListener('click', async () => {
  el.resetRankingStatus.textContent = 'Reiniciando…';
  el.resetRankingBtn.disabled = true;
  try {
    const resp = await fetch('/api/ranking', { method: 'DELETE' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `Error ${resp.status} del servidor`);
    el.resetRankingStatus.textContent = 'Ranking reiniciado.';
    el.setupRankingList.innerHTML = '<li>Todavía no hay puntajes guardados.</li>';
  } catch (err) {
    console.error(err);
    el.resetRankingStatus.textContent = err.message;
  } finally {
    el.resetRankingBtn.disabled = false;
  }
});

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
    foundName: hit.trackName,
    foundArtist: hit.artistName,
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

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function normalizeForMatch(str) {
  return normalize(str || '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function tokenOverlap(a, b) {
  const setA = new Set(a.split(' ').filter(Boolean));
  const setB = new Set(b.split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let common = 0;
  setA.forEach(tok => { if (setB.has(tok)) common += 1; });
  return common / Math.min(setA.size, setB.size);
}

// iTunes sometimes returns a cover version, a different song entirely, or a
// near-miss — this checks the top hit is actually close enough to what was
// requested before we trust it as the game's "correct answer" audio.
function isGoodMatch(requested, found) {
  const reqName = normalizeForMatch(requested.name);
  const foundName = normalizeForMatch(found.foundName);
  if (!reqName || !foundName) return false;

  const nameMatches = foundName.includes(reqName) || reqName.includes(foundName) || tokenOverlap(reqName, foundName) >= 0.6;
  if (!nameMatches) return false;
  if (!requested.artist) return true;

  const reqArtist = normalizeForMatch(requested.artist);
  const foundArtist = normalizeForMatch(found.foundArtist);
  return foundArtist.includes(reqArtist) || reqArtist.includes(foundArtist) || tokenOverlap(reqArtist, foundArtist) >= 0.4;
}

function logLoadingAttempt(requested, found, status) {
  const li = document.createElement('li');
  if (status === 'ok') {
    li.className = 'ok';
    li.textContent = `✓ ${requested.name} — ${requested.artist}`;
  } else if (status === 'mismatch') {
    li.className = 'mismatch';
    li.innerHTML = `✗ ${escapeHtml(requested.name)} — no coincide<small>Encontramos "${escapeHtml(found.foundName)} — ${escapeHtml(found.foundArtist)}"</small>`;
  } else {
    li.className = 'not-found';
    li.textContent = `✗ ${requested.name} — sin resultado en iTunes`;
  }
  el.loadingLog.prepend(li);
}

async function loadLibrary(entries, targetCount) {
  state.library = [];
  const pool = shuffle(entries);
  el.loadingLog.innerHTML = '';

  el.progressCount.textContent = `0 / ${targetCount}`;
  el.progressFill.style.width = '0%';

  for (let i = 0; i < pool.length && state.library.length < targetCount; i++) {
    const requested = pool[i];
    try {
      const found = await fetchPreview(requested);
      if (!found) {
        logLoadingAttempt(requested, null, 'not-found');
      } else if (!isGoodMatch(requested, found)) {
        logLoadingAttempt(requested, found, 'mismatch');
      } else {
        const audioBuffer = await decodeBuffer(found.previewUrl);
        state.library.push({
          id: `t${state.library.length}`,
          name: found.name,
          artist: found.artist,
          previewUrl: found.previewUrl,
          artworkUrl: found.artworkUrl,
          audioBuffer,
        });
        logLoadingAttempt(requested, found, 'ok');
      }
    } catch (err) {
      console.error('No se pudo cargar', requested, err);
      logLoadingAttempt(requested, null, 'not-found');
    }
    el.progressCount.textContent = `${state.library.length} / ${targetCount}`;
    el.progressFill.style.width = `${Math.min(100, (state.library.length / targetCount) * 100)}%`;
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
  state.startOffsetSec = (track.fixedOffsetSec != null)
    ? track.fixedOffsetSec
    : (dur > maxDurationSec + 1 ? Math.random() * (dur - maxDurationSec - 1) : 0);

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
  el.refreshPartyRankingBtn.hidden = !state.partyCode;

  if (state.partyCode && state.partyLivesMax != null) {
    const remaining = state.partyLivesMax - state.partyLivesUsed;
    el.partyLivesHint.textContent = remaining > 0
      ? `Te quedan ${remaining} intento${remaining === 1 ? '' : 's'} en esta party.`
      : 'Ya usaste todos tus intentos en esta party.';
    el.playAgainBtn.disabled = remaining <= 0;
    el.playAgainBtn.textContent = remaining <= 0 ? 'Sin intentos restantes' : 'Jugar de nuevo';
  } else {
    el.partyLivesHint.textContent = '';
    el.playAgainBtn.disabled = false;
    el.playAgainBtn.textContent = 'Jugar de nuevo';
  }

  showScreen('end');

  const endpoint = state.partyCode ? `/api/party?code=${state.partyCode}` : '/api/ranking';
  const body = state.partyCode
    ? { name: state.playerName, score: state.score }
    : { name: state.playerName, score: state.score, difficulty: state.difficulty };

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `Error ${resp.status} del servidor`);
    renderRanking(data.ranking);
  } catch (err) {
    console.error(err);
    el.rankingList.innerHTML = '';
    const li = document.createElement('li');
    li.textContent = `No pudimos guardar el puntaje: ${err.message}`;
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

el.refreshPartyRankingBtn.addEventListener('click', async () => {
  if (!state.partyCode) return;
  try {
    const resp = await fetch(`/api/party?code=${state.partyCode}`);
    if (!resp.ok) throw new Error('party-refresh-failed');
    const data = await resp.json();
    renderRanking(data.ranking);
  } catch (err) {
    console.error(err);
  }
});

el.playAgainBtn.addEventListener('click', async () => {
  // Inside a party, "play again" claims a brand new chunk from the shared
  // pool — never the same songs twice in a row.
  if (state.partyCode) {
    try {
      await claimPartyChunkAndPlay(state.partyCode);
    } catch (err) {
      console.error(err);
      showScreen('setup');
      showSetupError(`No pudimos conseguir canciones nuevas para la party: ${err.message}`);
    }
  } else {
    showScreen('setup');
  }
});

// ---------- Party mode ----------

function partyShareUrl(code) {
  return `${window.location.origin}${window.location.pathname}?party=${code}`;
}

function setSoloControlsVisible(visible) {
  document.querySelectorAll('[data-solo-only]').forEach(node => { node.hidden = !visible; });
}

el.createPartyBtn.addEventListener('click', async () => {
  el.setupError.hidden = true;

  const entries = getSelectedTrackEntries();
  const rounds = parseInt(el.partyRounds.value, 10) || 1;
  const name = el.playerName.value.trim();
  const livesInput = parseInt(el.partyLives.value, 10);
  const lives = (Number.isFinite(livesInput) && livesInput > 0) ? livesInput : null; // null = sin límite de intentos

  if (entries.length === 0) {
    const activeTab = document.querySelector('.tab.active').dataset.tab;
    return showSetupError(
      activeTab === 'spotify'
        ? 'Primero cargá una playlist con el botón "Cargar canciones".'
        : 'Pegá al menos una canción, una por línea.'
    );
  }
  if (!name) return showSetupError('Ingresá tu nombre.');

  state.difficulty = el.setupForm.querySelector('input[name="difficulty"]:checked').value;
  state.playerName = name;
  getAudioCtx();

  // Resolve a big shared pool (not just this player's rounds) so it can be
  // split into non-overlapping chunks as people join.
  const poolTarget = Math.min(entries.length, PARTY_POOL_CAP);
  showScreen('loading');
  await loadLibrary(entries, poolTarget);

  if (state.library.length === 0) {
    showScreen('setup');
    return showSetupError('No encontramos audio para ninguna de esas canciones. Probá con otros nombres.');
  }
  if (state.library.length < rounds) {
    showScreen('setup');
    return showSetupError(`Solo encontramos audio para ${state.library.length} canciones, y pediste ${rounds} por jugador. Bajá la "Cantidad de canciones" o probá con una playlist más grande.`);
  }

  // Fix each track's clip now, once — everyone who plays this song (whoever
  // ends up with it in their chunk) hears the exact same fragment.
  const maxDurationSec = DURATIONS_MS[state.difficulty][2] / 1000;
  state.library.forEach(track => {
    const dur = track.audioBuffer.duration;
    track.fixedOffsetSec = dur > maxDurationSec + 1 ? Math.random() * (dur - maxDurationSec - 1) : 0;
  });

  try {
    const createResp = await fetch('/api/party', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pool: state.library.map(t => ({
          name: t.name,
          artist: t.artist,
          previewUrl: t.previewUrl,
          startOffsetSec: t.fixedOffsetSec,
        })),
        difficulty: state.difficulty,
        rounds,
        lives,
      }),
    });
    const createData = await createResp.json().catch(() => ({}));
    if (!createResp.ok) throw new Error(createData.error || `Error ${createResp.status} del servidor`);

    state.partyCode = createData.code;
    el.partyShareLink.value = partyShareUrl(createData.code);
    el.partyShareCode.textContent = createData.code;
    el.partyCreatedError.hidden = true;
    showScreen('partyCreated');
  } catch (err) {
    console.error(err);
    showScreen('setup');
    showSetupError(`No pudimos crear la party: ${err.message}`);
  }
});

el.copyPartyLinkBtn.addEventListener('click', async () => {
  el.partyShareLink.select();
  try {
    await navigator.clipboard.writeText(el.partyShareLink.value);
    const original = el.copyPartyLinkBtn.textContent;
    el.copyPartyLinkBtn.textContent = '¡Copiado!';
    setTimeout(() => { el.copyPartyLinkBtn.textContent = original; }, 1500);
  } catch (err) {
    // Clipboard API blocked — the link is already selected as a manual fallback.
  }
});

// Claims a fresh, non-overlapping chunk of songs from a party's shared pool
// and starts playing it. Used for the first join AND every replay, so nobody
// ever gets the same set of songs twice in a row.
async function claimPartyChunkAndPlay(code) {
  const resp = await fetch(`/api/party?code=${code}&action=join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: state.playerName }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `Error ${resp.status} del servidor`);

  state.partyCode = code;
  state.difficulty = data.difficulty;
  state.partyLivesMax = data.livesMax; // null = sin límite
  state.partyLivesUsed = data.livesUsed || 0;

  showScreen('loading');
  el.loadingLog.innerHTML = '';
  el.progressCount.textContent = `0 / ${data.entries.length}`;
  el.progressFill.style.width = '0%';
  state.library = [];

  for (let i = 0; i < data.entries.length; i++) {
    const item = data.entries[i];
    try {
      const audioBuffer = await decodeBuffer(item.previewUrl);
      state.library.push({
        id: `t${i}`,
        name: item.name,
        artist: item.artist,
        previewUrl: item.previewUrl,
        fixedOffsetSec: item.startOffsetSec,
        audioBuffer,
      });
      logLoadingAttempt(item, null, 'ok');
    } catch (err) {
      console.error('No se pudo decodificar', item, err);
      logLoadingAttempt(item, null, 'not-found');
    }
    el.progressCount.textContent = `${i + 1} / ${data.entries.length}`;
    el.progressFill.style.width = `${((i + 1) / data.entries.length) * 100}%`;
  }

  if (state.library.length === 0) {
    throw new Error('No pudimos cargar el audio de esta party.');
  }

  state.totalRounds = state.library.length;
  state.roundIndex = 0;
  state.score = 0;
  state.playedIds = [];
  startRound();
}

el.startPartyGameBtn.addEventListener('click', async () => {
  el.partyCreatedError.hidden = true;
  el.startPartyGameBtn.disabled = true;
  try {
    await claimPartyChunkAndPlay(state.partyCode);
  } catch (err) {
    console.error(err);
    el.partyCreatedError.textContent = `No pudimos empezar: ${err.message}`;
    el.partyCreatedError.hidden = false;
    showScreen('partyCreated');
  } finally {
    el.startPartyGameBtn.disabled = false;
  }
});

function detectPartyFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('party');
  if (!code) return;

  state.pendingPartyCode = code.toUpperCase();
  el.partyCodeLabel.textContent = state.pendingPartyCode;
  el.partyJoinBanner.hidden = false;
  setSoloControlsVisible(false);
}

el.joinPartyBtn.addEventListener('click', async () => {
  const name = el.partyPlayerName.value.trim();
  if (!name) {
    el.partyJoinStatus.textContent = 'Ingresá tu nombre.';
    return;
  }

  el.partyJoinStatus.textContent = 'Cargando la party…';
  el.joinPartyBtn.disabled = true;
  getAudioCtx();
  state.playerName = name;

  try {
    await claimPartyChunkAndPlay(state.pendingPartyCode);
  } catch (err) {
    console.error(err);
    showScreen('setup');
    el.partyJoinStatus.textContent = `No pudimos unirte a la party: ${err.message}`;
  } finally {
    el.joinPartyBtn.disabled = false;
  }
});

detectPartyFromUrl();
