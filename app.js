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
  sessionRanking: [], // in-memory only, resets on reload — see note in UI
  spotifyEntries: null, // filled in by the "Buscar" button, { name, artist }[]
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
  spotifyUrl: document.getElementById('spotify-url'),
  fetchPlaylistBtn: document.getElementById('fetch-playlist-btn'),
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

function extractPlaylistId(input) {
  const match = input.match(/playlist[/:]([a-zA-Z0-9]+)/);
  return match ? match[1] : input.trim();
}

el.fetchPlaylistBtn.addEventListener('click', async () => {
  const raw = el.spotifyUrl.value.trim();
  if (!raw) return;

  el.spotifyStatus.textContent = 'Buscando la playlist…';
  el.fetchPlaylistBtn.disabled = true;
  state.spotifyEntries = null;

  try {
    const id = extractPlaylistId(raw);
    const resp = await fetch(`/api/playlist?playlistId=${encodeURIComponent(id)}`);
    if (!resp.ok) throw new Error('bad-response');
    const data = await resp.json();
    if (!data.tracks || data.tracks.length === 0) throw new Error('empty');
    state.spotifyEntries = data.tracks;
    el.spotifyStatus.textContent = `${data.tracks.length} canciones encontradas.`;
  } catch (err) {
    state.spotifyEntries = null;
    el.spotifyStatus.textContent = 'No pudimos leer la playlist. Esto solo funciona una vez desplegado en Vercel con las funciones activas — mientras tanto probá con la pestaña "Lista manual".';
  } finally {
    el.fetchPlaylistBtn.disabled = false;
  }
});

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

function endGame() {
  const entry = { name: state.playerName, score: state.score };
  state.sessionRanking.push(entry);
  state.sessionRanking.sort((a, b) => b.score - a.score);

  el.endName.textContent = state.playerName;
  el.endScore.textContent = state.score;

  el.rankingList.innerHTML = '';
  state.sessionRanking.slice(0, 10).forEach(item => {
    const li = document.createElement('li');
    if (item === entry) li.classList.add('you');
    li.innerHTML = `<span>${escapeHtml(item.name)}</span><span>${item.score} pts</span>`;
    el.rankingList.appendChild(li);
  });

  showScreen('end');
}

el.playAgainBtn.addEventListener('click', () => {
  showScreen('setup');
});
