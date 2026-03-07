/* ============================================================
   ANIME PAUSE GAME — game.js
   ============================================================ */

// ── State ────────────────────────────────────────────────────
let currentAnime   = null;
let currentStatIdx = 0;
let pickedChars    = [];        // [{stat, statKey, character, score}]
let spinInterval   = null;
let spinIndex      = 0;
let paused         = false;
let speedMs        = 80;        // ms per card tick

// ── Image Cache ──────────────────────────────────────────────
// Maps character name → image URL (populated via Jikan API)
const imageCache = {};

// Fetch with a timeout so API calls never hang indefinitely
function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// Convert MAL's "Last, First" → "First Last" for matching
function normalizeMALName(malName) {
  if (malName.includes(',')) {
    const [last, first] = malName.split(',').map(s => s.trim());
    return `${first} ${last}`.toLowerCase();
  }
  return malName.toLowerCase();
}

async function buildApiLookup(malId) {
  const lookup = {};
  try {
    const res  = await fetchWithTimeout(`https://api.jikan.moe/v4/anime/${malId}/characters`);
    const json = await res.json();
    if (json.data) {
      json.data.forEach(entry => {
        const c = entry.character;
        if (c?.name && c?.images?.jpg?.image_url) {
          const url = c.images.jpg.image_url;
          lookup[normalizeMALName(c.name)] = url;
          lookup[c.name.toLowerCase()]     = url;
        }
      });
    }
  } catch (_) {}
  return lookup;
}

// Fetch a character image directly by their MAL character ID (100% reliable, no name matching)
async function fetchCharacterById(malCharId) {
  try {
    const res  = await fetchWithTimeout(`https://api.jikan.moe/v4/characters/${malCharId}`);
    const json = await res.json();
    return json.data?.images?.jpg?.image_url || null;
  } catch (_) { return null; }
}

// Individual character search — fallback when anime roster lookup misses someone
async function searchCharacterImage(searchName, exactName) {
  try {
    const res  = await fetchWithTimeout(
      `https://api.jikan.moe/v4/characters?q=${encodeURIComponent(searchName)}&limit=8`
    );
    const json = await res.json();
    if (!json.data || json.data.length === 0) return null;

    // Prefer exact name match against the character's canonical MAL name
    const lower = (exactName || searchName).toLowerCase();
    const exact = json.data.find(c =>
      normalizeMALName(c.name) === lower || c.name.toLowerCase() === lower
    );
    // Fallback: highest-favorites result (most canonical character)
    const best = exact || json.data.reduce((a, b) =>
      (b.favorites || 0) > (a.favorites || 0) ? b : a
    );
    return best?.images?.jpg?.image_url || null;
  } catch (_) { return null; }
}

async function fetchCharacterImages(anime) {
  const characters  = anime.characters;
  const avatarsCont = document.getElementById('loading-avatars');
  const fillBar     = document.getElementById('loading-bar-fill');
  const charNameEl  = document.getElementById('loading-char-name');

  // Pre-create avatar slots with emoji placeholders
  avatarsCont.innerHTML = '';
  const slots = characters.map(char => {
    const slot  = document.createElement('div');
    slot.className = 'loading-avatar';
    const inner = document.createElement('div');
    inner.className = 'loading-avatar-emoji';
    inner.textContent = char.emoji;
    slot.appendChild(inner);
    avatarsCont.appendChild(slot);
    return slot;
  });

  // ── Step 1: fetch anime roster (one request, correct show scope) ──────────
  charNameEl.textContent = `Fetching ${anime.name} roster…`;
  fillBar.style.width = '5%';

  let rosterLookup = {};
  if (anime.malId) {
    rosterLookup = await buildApiLookup(anime.malId);
  }
  if (anime.extraMalId) {
    const extra = await buildApiLookup(anime.extraMalId);
    Object.assign(rosterLookup, extra);
  }
  fillBar.style.width = '15%';

  // ── Step 2: resolve each character ───────────────────────────────────────
  for (let i = 0; i < characters.length; i++) {
    const char = characters[i];
    charNameEl.textContent = char.name;
    fillBar.style.width = `${Math.round(15 + (i / characters.length) * 85)}%`;

    if (imageCache[char.name] !== undefined) {
      // Already resolved from a previous load of this anime
    } else {
      let url = null;

      // Priority 0: direct MAL character ID lookup (used for characters that break name matching)
      if (char.malCharId) {
        url = await fetchCharacterById(char.malCharId);
        await new Promise(r => setTimeout(r, 380));
      }

      if (!url) {
        // Try all name variants against the roster lookup (no extra request)
        const variants = [];
        if (char.malName) {
          variants.push(char.malName.toLowerCase());
          variants.push(normalizeMALName(char.malName));
        }
        variants.push(char.name.toLowerCase());
        variants.push(normalizeMALName(char.name));

        for (const v of variants) {
          if (rosterLookup[v]) { url = rosterLookup[v]; break; }
        }
      }

      // Roster lookup missed this character — do individual search as fallback
      if (!url) {
        // searchQuery is a disambiguating phrase (e.g. "Son Goku Dragon Ball Z")
        // exactName is the real MAL name used for exact-match selection within results
        const searchQuery = char.searchQuery || char.malName || char.name;
        const exactName   = char.malName || char.name;
        url = await searchCharacterImage(searchQuery, exactName);
        await new Promise(r => setTimeout(r, 380)); // respect 3 req/s rate limit
      }

      imageCache[char.name] = url || null;
    }

    const url = imageCache[char.name];
    if (url) {
      slots[i].innerHTML = `<img src="${url}" alt="${char.name}" loading="lazy" />`;
    }
    slots[i].classList.add('loaded');
    await new Promise(r => setTimeout(r, 60));
  }

  fillBar.style.width = '100%';
  charNameEl.textContent = 'Ready!';
  await new Promise(r => setTimeout(r, 350));
}

const CARD_HEIGHT        = 118;  // card height (110) + gap (8)
const VISIBLE_HALF       = 3;   // cards visible above / below center
const SPIN_CENTER_OFFSET = 2;   // how many indices ahead of spinIndex the centered card sits

// Returns the stat keys for the currently active anime (or global default)
function activeKeys() { return (currentAnime && currentAnime.statKeys) ? currentAnime.statKeys : STAT_KEYS; }

// Returns display name for a stat key
function statLabel(key) { return STAT_LABELS[key] || key; }

// ── Screens ─────────────────────────────────────────────────
function goHome() {
  if (spinInterval) clearInterval(spinInterval);
  currentAnime  = null;
  pickedChars   = [];
  currentStatIdx = 0;
  showAnimeSelect();
}

function showScreen(id) {
  // Show/hide home logo — hidden on title and select screens
  const logo = document.getElementById('home-logo');
  if (logo) logo.classList.toggle('hidden', id === 'screen-title' || id === 'screen-select');
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Title Screen ─────────────────────────────────────────────
(function spawnParticles() {
  const cont = document.getElementById('particles');
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const colors = ['#7c3aed','#06b6d4','#f59e0b','#ef4444','#10b981'];
    p.style.cssText = `
      left: ${Math.random()*100}%;
      width: ${Math.random()*4+2}px;
      height: ${Math.random()*4+2}px;
      background: ${colors[Math.floor(Math.random()*colors.length)]};
      animation-duration: ${Math.random()*6+4}s;
      animation-delay: ${Math.random()*6}s;
    `;
    cont.appendChild(p);
  }
})();

// Build anime grid immediately on load (title screen is skipped)
buildAnimeGrid();

// ── Anime Select ─────────────────────────────────────────────
function showAnimeSelect() {
  buildAnimeGrid();
  showScreen('screen-select');
}

function buildAnimeGrid() {
  const grid = document.getElementById('anime-grid');
  grid.innerHTML = '';
  for (const [key, anime] of Object.entries(ANIME_DATA)) {
    const card = document.createElement('div');
    card.className = 'anime-card';
    card.style.setProperty('--anime-color', anime.color);
    card.innerHTML = `
      <div class="anime-card-emoji">${anime.emoji}</div>
      <div class="anime-card-name">${anime.name}</div>
      <div class="anime-card-count">${anime.characters.length} characters</div>
    `;
    card.addEventListener('click', () => startGame(key));
    grid.appendChild(card);
  }
}

// ── Start Game ───────────────────────────────────────────────
async function startGame(animeKey) {
  currentAnime   = ANIME_DATA[animeKey];
  currentStatIdx = 0;
  pickedChars    = [];

  // Show loading screen and fetch images
  document.getElementById('loading-anime-name').textContent = currentAnime.name.toUpperCase();
  document.getElementById('loading-anime-name').style.color = currentAnime.color;
  document.getElementById('loading-bar-fill').style.width   = '0%';
  document.getElementById('loading-char-name').textContent  = '';
  showScreen('screen-loading');

  // Timeout fallback — if images take >20s (API unavailable/slow), start without them
  await Promise.race([
    fetchCharacterImages(currentAnime),
    new Promise(resolve => setTimeout(resolve, 20000))
  ]);

  // Now launch the game
  showScreen('screen-game');
  document.getElementById('game-anime-name').textContent = currentAnime.name.toUpperCase();
  updatePickedPanel();
  startStatRound();
}

function restartSameAnime() {
  startGame(Object.keys(ANIME_DATA).find(k => ANIME_DATA[k] === currentAnime));
}

// ── Stat Round ───────────────────────────────────────────────
function startStatRound() {
  paused   = false;
  spinIndex = 0;

  const statKey  = activeKeys()[currentStatIdx];
  const statName = statLabel(statKey);
  const statIcon = STAT_ICONS[statKey];
  const statColor= STAT_COLORS[statKey];

  // Header
  document.getElementById('current-stat-icon').textContent = statIcon;
  document.getElementById('current-stat-name').textContent = statName;
  document.getElementById('current-stat-name').style.color = statColor;
  document.getElementById('stat-progress-text').textContent =
    `Stat ${currentStatIdx + 1} of ${activeKeys().length}`;

  // Progress dots
  buildDots();

  // Spinner
  buildSpinner(statKey, statColor);

  // Enable pause button
  const btn = document.getElementById('btn-pause');
  btn.disabled = false;
  btn.textContent = '⏸ PAUSE';

  // Vary speed per stat for fun
  speedMs = 60 + Math.random() * 60;

  startSpinning(statKey);
}

function buildDots() {
  const cont = document.getElementById('progress-dots');
  cont.innerHTML = '';
  for (let i = 0; i < activeKeys().length; i++) {
    const d = document.createElement('div');
    d.className = 'dot' + (i < currentStatIdx ? ' done' : i === currentStatIdx ? ' active' : '');
    cont.appendChild(d);
  }
}

// ── Spinner ──────────────────────────────────────────────────
function buildSpinner(statKey, statColor) {
  const track = document.getElementById('spinner-track');
  track.innerHTML = '';
  track.style.transform = 'translateY(0)';

  const chars = [...currentAnime.characters, ...currentAnime.characters, ...currentAnime.characters];
  chars.forEach((char, i) => {
    const card = document.createElement('div');
    card.className = 'spin-card';
    card.dataset.idx = i % currentAnime.characters.length;

    const statVal  = char[statKey] ?? 0;
    const imgUrl   = imageCache[char.name];
    const portrait = imgUrl
      ? `<div class="spin-card-portrait"><img src="${imgUrl}" alt="${char.name}" /></div>`
      : `<div class="spin-card-portrait"><div class="spin-card-portrait-emoji">${char.emoji}</div></div>`;

    const statDisplay = (statKey === 'form' && char.formName)
      ? `${char.formName} <span style="opacity:0.7">(${statVal}/10)</span>`
      : (statKey === 'cursedTechnique' && char.ctName)
        ? `${char.ctName} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'breathingStyle')
        ? `${char.breathingName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'devilFruit')
        ? `${char.devilFruitName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'haki')
        ? `${char.hakiName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'domainExpansion')
        ? `${char.domainName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'chakra')
        ? `${char.chakraName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'mainJutsu')
        ? `${char.jutsuName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'eyes')
        ? `${char.eyeName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'quirk')
        ? `${char.quirkName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'reiatsu')
        ? `${char.reiName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'zanpakuto')
        ? `${char.zanpakutoName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'bankai')
        ? `${char.bankaiName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'nen')
        ? `${char.nenType || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'hatsu')
        ? `${char.hatsuName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'devilPower')
        ? `${char.devilName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'contract')
        ? `${char.contractName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'heroRank')
        ? `${char.rankName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'magic')
        ? `${char.magicName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : (statKey === 'grimoire')
        ? `${char.grimoireName || 'None'} <span style="opacity:0.7">(${statVal}/10)</span>`
        : `${statVal}/10`;

    card.innerHTML = `
      ${portrait}
      <div class="spin-card-info">
        <div class="spin-card-name">${char.name}</div>
        <div class="spin-card-stat" style="color:${statColor}">${STAT_ICONS[statKey]} ${statDisplay}</div>
      </div>
    `;
    track.appendChild(card);
  });
}

function startSpinning(statKey) {
  if (spinInterval) clearInterval(spinInterval);

  const track  = document.getElementById('spinner-track');
  const cards  = track.querySelectorAll('.spin-card');
  const total  = currentAnime.characters.length;

  // Start from the middle group
  spinIndex = total;

  spinInterval = setInterval(() => {
    if (paused) return;

    spinIndex++;
    // When we reach the last group, reset to middle group seamlessly
    if (spinIndex >= total * 2) spinIndex = total;

    const yOffset = -(spinIndex * CARD_HEIGHT) + (VISIBLE_HALF * CARD_HEIGHT);
    track.style.transform = `translateY(${yOffset}px)`;

    // Highlight the card that is visually centered inside the selector box
    const centeredCardIdx = spinIndex - SPIN_CENTER_OFFSET;
    cards.forEach((c, i) => c.classList.toggle('highlighted', i === centeredCardIdx));
  }, speedMs);
}

// ── Pause ─────────────────────────────────────────────────────
function pauseSpinner() {
  if (paused) return;
  paused = true;

  const btn = document.getElementById('btn-pause');
  btn.disabled = true;
  btn.textContent = '✓ PAUSED';

  // Flash the selector ring
  const sel = document.querySelector('.spinner-selector');
  sel.classList.add('paused');
  setTimeout(() => sel.classList.remove('paused'), 800);

  // Determine selected character — use the same centered-card offset as the highlight
  const total    = currentAnime.characters.length;
  const charIdx  = ((spinIndex - SPIN_CENTER_OFFSET) % total + total) % total;
  const statKey  = activeKeys()[currentStatIdx];
  const char     = currentAnime.characters[charIdx];
  const score    = char[statKey] ?? 0;

  pickedChars.push({
    stat:     statLabel(statKey),
    statKey,
    statIcon: STAT_ICONS[statKey],
    statColor:STAT_COLORS[statKey],
    character: char,
    score
  });

  updatePickedPanel();

  // Advance after a short pause
  setTimeout(() => {
    currentStatIdx++;
    if (currentStatIdx < activeKeys().length) {
      startStatRound();
    } else {
      clearInterval(spinInterval);
      showResults();
    }
  }, 900);
}

// ── Keyboard support ─────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && document.getElementById('screen-game').classList.contains('active')) {
    e.preventDefault();
    pauseSpinner();
  }
});

// ── Picked Panel ─────────────────────────────────────────────
function updatePickedPanel() {
  const list = document.getElementById('picked-list');
  list.innerHTML = '';

  if (pickedChars.length === 0) {
    list.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;text-align:center;padding:1rem">No picks yet...</div>';
    return;
  }

  pickedChars.forEach(p => {
    const item = document.createElement('div');
    item.className = 'picked-item';
    item.style.setProperty('--stat-color', p.statColor);
    const scoreDisplay = (p.statKey === 'form' && p.character.formName)
      ? `<span style="font-size:0.75rem">${p.character.formName}</span>`
      : (p.statKey === 'cursedTechnique' && p.character.ctName)
        ? `<span style="font-size:0.75rem">${p.character.ctName}</span>`
      : (p.statKey === 'breathingStyle')
        ? `<span style="font-size:0.75rem">${p.character.breathingName || 'None'}</span>`
      : (p.statKey === 'devilFruit')
        ? `<span style="font-size:0.75rem">${p.character.devilFruitName || 'None'}</span>`
      : (p.statKey === 'haki')
        ? `<span style="font-size:0.75rem">${p.character.hakiName || 'None'}</span>`
      : (p.statKey === 'domainExpansion')
        ? `<span style="font-size:0.75rem">${p.character.domainName || 'None'}</span>`
      : (p.statKey === 'chakra')
        ? `<span style="font-size:0.75rem">${p.character.chakraName || 'None'}</span>`
      : (p.statKey === 'mainJutsu')
        ? `<span style="font-size:0.75rem">${p.character.jutsuName || 'None'}</span>`
      : (p.statKey === 'eyes')
        ? `<span style="font-size:0.75rem">${p.character.eyeName || 'None'}</span>`
      : (p.statKey === 'quirk')
        ? `<span style="font-size:0.75rem">${p.character.quirkName || 'None'}</span>`
      : (p.statKey === 'reiatsu')
        ? `<span style="font-size:0.75rem">${p.character.reiName || 'None'}</span>`
      : (p.statKey === 'zanpakuto')
        ? `<span style="font-size:0.75rem">${p.character.zanpakutoName || 'None'}</span>`
      : (p.statKey === 'bankai')
        ? `<span style="font-size:0.75rem">${p.character.bankaiName || 'None'}</span>`
      : (p.statKey === 'nen')
        ? `<span style="font-size:0.75rem">${p.character.nenType || 'None'}</span>`
      : (p.statKey === 'hatsu')
        ? `<span style="font-size:0.75rem">${p.character.hatsuName || 'None'}</span>`
      : (p.statKey === 'devilPower')
        ? `<span style="font-size:0.75rem">${p.character.devilName || 'None'}</span>`
      : (p.statKey === 'contract')
        ? `<span style="font-size:0.75rem">${p.character.contractName || 'None'}</span>`
      : (p.statKey === 'heroRank')
        ? `<span style="font-size:0.75rem">${p.character.rankName || 'None'}</span>`
      : (p.statKey === 'magic')
        ? `<span style="font-size:0.75rem">${p.character.magicName || 'None'}</span>`
      : (p.statKey === 'grimoire')
        ? `<span style="font-size:0.75rem">${p.character.grimoireName || 'None'}</span>`
        : `${p.score}/10`;
    item.innerHTML = `
      <div class="picked-stat-icon">${p.statIcon}</div>
      <div class="picked-info">
        <div class="picked-stat-name">${p.stat}</div>
        <div class="picked-char-name">${p.character.name}</div>
      </div>
      <div class="picked-char-emoji">${p.character.emoji}</div>
      <div class="picked-score" style="color:${p.statColor}">${scoreDisplay}</div>
    `;
    list.appendChild(item);
  });
}

// ── Results ──────────────────────────────────────────────────
function showResults() {
  const totalScore = pickedChars.reduce((s, p) => s + p.score, 0);
  const maxScore   = activeKeys().length * 10;
  const tier = getTier(totalScore, maxScore);

  // Tier badge
  const badge = document.getElementById('results-tier-badge');
  badge.textContent = tier.tier;
  badge.style.color = tier.color;

  // Anime name
  document.getElementById('results-anime-name').textContent = currentAnime.name.toUpperCase();
  document.getElementById('results-anime-name').style.color = currentAnime.color;

  // Total score
  document.getElementById('total-score').textContent = totalScore;
  document.getElementById('total-score').style.color = tier.color;
  document.getElementById('total-max').textContent   = '/ ' + maxScore;

  // Cards
  const grid = document.getElementById('results-grid');
  grid.innerHTML = '';
  pickedChars.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.style.setProperty('--stat-color', p.statColor);
    card.style.animationDelay = `${i * 0.1}s`;
    const imgUrl   = imageCache[p.character.name];
    const portrait = imgUrl
      ? `<div class="result-portrait"><img src="${imgUrl}" alt="${p.character.name}" /></div>`
      : `<div class="result-portrait"><div class="result-portrait-emoji">${p.character.emoji}</div></div>`;

    const scoreLabel = (p.statKey === 'form' && p.character.formName)
      ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.formName}</div>
         <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'cursedTechnique' && p.character.ctName)
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.ctName}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'breathingStyle')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.breathingName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'devilFruit')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.devilFruitName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'haki')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.hakiName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'domainExpansion')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.domainName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'chakra')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.chakraName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'mainJutsu')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.jutsuName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'eyes')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.eyeName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'quirk')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.quirkName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'reiatsu')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.reiName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'zanpakuto')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.zanpakutoName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'bankai')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.bankaiName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'nen')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.nenType || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'hatsu')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.hatsuName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'devilPower')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.devilName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'contract')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.contractName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'heroRank')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.rankName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'magic')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.magicName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
      : (p.statKey === 'grimoire')
        ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${p.character.grimoireName || 'None'}</div>
           <div class="result-score-num" style="color:${p.statColor};font-size:0.9rem">${p.score}/10</div>`
        : `<div class="result-score-num" style="color:${p.statColor}">${p.score}/10</div>`;

    card.innerHTML = `
      <div class="result-stat-row">${p.statIcon} ${p.stat.toUpperCase()}</div>
      ${portrait}
      <div class="result-char-name">${p.character.name}</div>
      ${scoreLabel}
      <div class="result-score-bar">
        <div class="result-score-fill" style="width:0%;background:${p.statColor}"
             data-width="${p.score * 10}%"></div>
      </div>
    `;
    grid.appendChild(card);
  });

  showScreen('screen-results');

  // Animate bars after a tick
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll('.result-score-fill').forEach(el => {
      el.style.width = el.dataset.width;
    });
  }));

  // Draw radar chart
  setTimeout(() => drawRadar(pickedChars), 300);
}

// ── Radar Chart ──────────────────────────────────────────────
function drawRadar(picks) {
  const canvas = document.getElementById('radar-canvas');
  const ctx    = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const R  = W / 2 - 40;
  const N  = picks.length;

  ctx.clearRect(0, 0, W, H);

  const angle = i => (Math.PI * 2 * i / N) - Math.PI / 2;
  const point = (i, r) => ({
    x: cx + Math.cos(angle(i)) * r,
    y: cy + Math.sin(angle(i)) * r,
  });

  // Grid rings
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let ring = 1; ring <= 5; ring++) {
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const p = point(i, R * ring / 5);
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  // Spokes
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  picks.forEach((_, i) => {
    const p = point(i, R);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });

  // Data polygon
  ctx.beginPath();
  picks.forEach((p, i) => {
    const r = R * p.score / 10;
    const pt = point(i, r);
    i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y);
  });
  ctx.closePath();
  ctx.fillStyle   = 'rgba(124,58,237,0.25)';
  ctx.strokeStyle = '#7c3aed';
  ctx.lineWidth   = 2.5;
  ctx.fill();
  ctx.stroke();

  // Dots
  picks.forEach((p, i) => {
    const r  = R * p.score / 10;
    const pt = point(i, r);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = p.statColor;
    ctx.fill();
  });

  // Labels
  ctx.font       = 'bold 11px Segoe UI, sans-serif';
  ctx.fillStyle  = '#e8e8f0';
  ctx.textAlign  = 'center';
  picks.forEach((p, i) => {
    const pt = point(i, R + 24);
    ctx.fillText(`${p.statIcon} ${p.stat.slice(0,4).toUpperCase()}`, pt.x, pt.y + 4);
  });
}
