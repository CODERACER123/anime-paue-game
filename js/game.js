/* ============================================================
   ANIME PAUSE GAME — game.js
   ============================================================ */

// ── State ────────────────────────────────────────────────────
let currentAnime   = null;
let currentStatIdx = 0;
let currentMode    = 'classic'; // 'classic' | 'murderMystery' | 'buildFamily'
let pickedChars    = [];        // [{stat, statKey, statIcon, statColor, character, score}]
let spinInterval   = null;
let spinIndex      = 0;
let paused         = false;
let speedMs        = 80;        // ms per card tick

// ── Game Modes ───────────────────────────────────────────────
const GAME_MODES = {
  classic: {
    name: 'Classic Mode', icon: '⚔️', color: '#7c3aed',
    description: 'Build your ultimate power team based on stats',
  },
  murderMystery: {
    name: 'Murder Mystery', icon: '🔪', color: '#ef4444',
    description: 'Cast your characters into a gripping murder mystery',
    roles: [
      { key: 'murderer',   icon: '🔪', name: 'The Murderer',   color: '#ef4444' },
      { key: 'detective',  icon: '🕵️', name: 'The Detective',  color: '#06b6d4' },
      { key: 'victim',     icon: '💀', name: 'The Victim',     color: '#8b5cf6' },
      { key: 'suspect',    icon: '🫣', name: 'The Suspect',    color: '#f59e0b' },
      { key: 'witness',    icon: '👁️', name: 'The Witness',    color: '#10b981' },
      { key: 'mastermind', icon: '🧠', name: 'The Mastermind', color: '#f97316' },
    ],
  },
  buildFamily: {
    name: 'Build Your Family', icon: '👨‍👩‍👧‍👦', color: '#10b981',
    description: 'Assemble your perfect anime family',
    roles: [
      { key: 'dad',        icon: '👨', name: 'The Dad',          color: '#3b82f6' },
      { key: 'mom',        icon: '👩', name: 'The Mom',          color: '#ec4899' },
      { key: 'olderSib',   icon: '🧑', name: 'Older Sibling',    color: '#8b5cf6' },
      { key: 'youngerSib', icon: '🧒', name: 'Younger Sibling',  color: '#f59e0b' },
      { key: 'baby',       icon: '👶', name: 'The Baby',         color: '#10b981' },
      { key: 'mascot',     icon: '🐾', name: 'Family Mascot',    color: '#f97316' },
    ],
  },
};

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


// Returns the stat keys for the currently active anime (or global default)
function activeKeys() { return (currentAnime && currentAnime.statKeys) ? currentAnime.statKeys : STAT_KEYS; }

// Returns role objects for the current mode (works for all modes)
function activeRoles() {
  if (currentMode !== 'classic') return GAME_MODES[currentMode].roles;
  return activeKeys().map(k => ({ key: k, icon: STAT_ICONS[k], name: statLabel(k), color: STAT_COLORS[k] }));
}

// Returns display name for a stat key
function statLabel(key) { return STAT_LABELS[key] || key; }

// ── Screens ─────────────────────────────────────────────────
function goHome() {
  if (spinInterval) clearInterval(spinInterval);
  currentAnime   = null;
  currentMode    = 'classic';
  pickedChars    = [];
  currentStatIdx = 0;
  showAnimeSelect();
}

function showScreen(id) {
  // Show/hide home logo — hidden on title and select screens
  const logo = document.getElementById('home-logo');
  if (logo) logo.classList.toggle('hidden',
    id === 'screen-title' || id === 'screen-select' || id === 'screen-mode-select');
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
function startGame(animeKey) {
  currentAnime   = ANIME_DATA[animeKey];
  currentStatIdx = 0;
  pickedChars    = [];
  showModeSelect();
}

function restartSameAnime() {
  // Replay with same anime + same mode, images already cached
  if (spinInterval) clearInterval(spinInterval);
  currentStatIdx = 0;
  pickedChars    = [];
  showScreen('screen-game');
  document.getElementById('game-anime-name').textContent = currentAnime.name.toUpperCase();
  updatePickedPanel();
  startStatRound();
}

function pickDifferentMode() {
  // Same anime, choose a new mode — images already cached
  if (spinInterval) clearInterval(spinInterval);
  currentStatIdx = 0;
  pickedChars    = [];
  showModeSelect();
}

// ── Mode Select ───────────────────────────────────────────────
function showModeSelect() {
  const grid = document.getElementById('mode-grid');
  grid.innerHTML = '';
  for (const [key, mode] of Object.entries(GAME_MODES)) {
    const card = document.createElement('div');
    card.className = 'mode-card';
    card.style.setProperty('--mode-color', mode.color);
    const rolesHtml = mode.roles
      ? `<div class="mode-card-roles">${mode.roles.map(r => `<span>${r.icon} ${r.name}</span>`).join('')}</div>`
      : '';
    card.innerHTML = `
      <div class="mode-card-icon">${mode.icon}</div>
      <div class="mode-card-name">${mode.name}</div>
      <div class="mode-card-desc">${mode.description}</div>
      ${rolesHtml}
    `;
    card.addEventListener('click', () => selectMode(key));
    grid.appendChild(card);
  }
  showScreen('screen-mode-select');
}

async function selectMode(modeKey) {
  currentMode    = modeKey;
  currentStatIdx = 0;
  pickedChars    = [];

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

  showScreen('screen-game');
  document.getElementById('game-anime-name').textContent = currentAnime.name.toUpperCase();
  updatePickedPanel();
  startStatRound();
}

// ── Stat Round ───────────────────────────────────────────────
function startStatRound() {
  paused   = false;
  spinIndex = 0;

  const role = activeRoles()[currentStatIdx];

  // Header
  document.getElementById('current-stat-icon').textContent = role.icon;
  document.getElementById('current-stat-name').textContent = role.name;
  document.getElementById('current-stat-name').style.color = role.color;
  document.getElementById('stat-progress-text').textContent =
    `${currentMode === 'classic' ? 'Stat' : 'Role'} ${currentStatIdx + 1} of ${activeRoles().length}`;

  // Progress dots
  buildDots();

  // Enable pause button
  const btn = document.getElementById('btn-pause');
  btn.disabled = false;
  btn.textContent = '⏸ PAUSE';

  // 220–320ms per card
  speedMs = 220 + Math.random() * 100;

  startFlipper(role.key, role.icon, role.color);
}

function buildDots() {
  const cont = document.getElementById('progress-dots');
  cont.innerHTML = '';
  for (let i = 0; i < activeRoles().length; i++) {
    const d = document.createElement('div');
    d.className = 'dot' + (i < currentStatIdx ? ' done' : i === currentStatIdx ? ' active' : '');
    cont.appendChild(d);
  }
}

// ── Flipper ──────────────────────────────────────────────────
function getStatDisplay(char, statKey) {
  const v = char[statKey] ?? 0;
  if (statKey === 'form'            && char.formName)  return `${char.formName} (${v}/10)`;
  if (statKey === 'cursedTechnique' && char.ctName)    return `${char.ctName} (${v}/10)`;
  if (statKey === 'breathingStyle')  return `${char.breathingName  || 'None'} (${v}/10)`;
  if (statKey === 'devilFruit')      return `${char.devilFruitName || 'None'} (${v}/10)`;
  if (statKey === 'haki')            return `${char.hakiName       || 'None'} (${v}/10)`;
  if (statKey === 'domainExpansion') return `${char.domainName     || 'None'} (${v}/10)`;
  if (statKey === 'chakra')          return `${char.chakraName     || 'None'} (${v}/10)`;
  if (statKey === 'mainJutsu')       return `${char.jutsuName      || 'None'} (${v}/10)`;
  if (statKey === 'eyes')            return `${char.eyeName        || 'None'} (${v}/10)`;
  if (statKey === 'quirk')           return `${char.quirkName      || 'None'} (${v}/10)`;
  if (statKey === 'reiatsu')         return `${char.reiName        || 'None'} (${v}/10)`;
  if (statKey === 'zanpakuto')       return `${char.zanpakutoName  || 'None'} (${v}/10)`;
  if (statKey === 'bankai')          return `${char.bankaiName     || 'None'} (${v}/10)`;
  if (statKey === 'nen')             return `${char.nenType        || 'None'} (${v}/10)`;
  if (statKey === 'hatsu')           return `${char.hatsuName      || 'None'} (${v}/10)`;
  if (statKey === 'devilPower')      return `${char.devilName      || 'None'} (${v}/10)`;
  if (statKey === 'contract')        return `${char.contractName   || 'None'} (${v}/10)`;
  if (statKey === 'heroRank')        return `${char.rankName       || 'None'} (${v}/10)`;
  if (statKey === 'magic')           return `${char.magicName      || 'None'} (${v}/10)`;
  if (statKey === 'grimoire')        return `${char.grimoireName   || 'None'} (${v}/10)`;
  return `${v}/10`;
}

function startFlipper(roleKey, roleIcon, roleColor) {
  if (spinInterval) clearInterval(spinInterval);

  const total = currentAnime.characters.length;
  spinIndex = Math.floor(Math.random() * total); // start at random position

  function showCard(idx) {
    const char   = currentAnime.characters[idx % total];
    const imgUrl = imageCache[char.name];

    const nameEl     = document.getElementById('flipper-name');
    const portraitEl = document.getElementById('flipper-portrait-wrap');
    const ratingEl   = document.getElementById('flipper-rating');
    const display    = document.getElementById('flipper-display');

    // Trigger flip animation
    display.classList.remove('flip-in');
    void display.offsetWidth;
    display.classList.add('flip-in');

    nameEl.textContent = char.name;
    portraitEl.innerHTML = imgUrl
      ? `<img src="${imgUrl}" alt="${char.name}" />`
      : `<div class="flipper-emoji">${char.emoji}</div>`;

    if (currentMode === 'classic') {
      const statDisplay = getStatDisplay(char, roleKey);
      ratingEl.innerHTML = `<span class="flipper-stat-icon">${STAT_ICONS[roleKey]}</span> <span class="flipper-stat-val" style="color:${roleColor}">${statDisplay}</span>`;
    } else {
      // Non-classic: just show the character's emoji as flavour
      ratingEl.innerHTML = `<span style="font-size:1.25rem">${char.emoji}</span>`;
    }
  }

  showCard(spinIndex);

  spinInterval = setInterval(() => {
    if (paused) return;
    spinIndex = (spinIndex + 1) % total;
    showCard(spinIndex);
  }, speedMs);
}

// ── Pause ─────────────────────────────────────────────────────
function pauseSpinner() {
  if (paused) return;
  paused = true;

  const btn = document.getElementById('btn-pause');
  btn.disabled = true;
  btn.textContent = '✓ PAUSED';

  // Flash the flipper display
  const display = document.getElementById('flipper-display');
  display.classList.add('flipper-paused');
  setTimeout(() => display.classList.remove('flipper-paused'), 800);

  const total = currentAnime.characters.length;
  const role  = activeRoles()[currentStatIdx];
  const char  = currentAnime.characters[spinIndex % total];
  const score = currentMode === 'classic' ? (char[role.key] ?? 0) : 0;

  pickedChars.push({
    stat:      role.name,
    statKey:   role.key,
    statIcon:  role.icon,
    statColor: role.color,
    character: char,
    score
  });

  updatePickedPanel();

  // Advance after a short pause
  setTimeout(() => {
    currentStatIdx++;
    if (currentStatIdx < activeRoles().length) {
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
    // For non-classic modes, just show a checkmark instead of a stat score
    const scoreDisplay = currentMode !== 'classic'
      ? `<span style="font-size:1rem">✓</span>`
      : (p.statKey === 'form' && p.character.formName)
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
  const isClassic = currentMode === 'classic';
  const mode      = GAME_MODES[currentMode];

  // ── Badge + header ──
  const badge = document.getElementById('results-tier-badge');
  if (isClassic) {
    const totalScore = pickedChars.reduce((s, p) => s + p.score, 0);
    const maxScore   = activeRoles().length * 10;
    const tier = getTier(totalScore, maxScore);
    badge.textContent   = tier.tier;
    badge.style.color   = tier.color;
    badge.style.fontSize = '';
    document.getElementById('total-score').textContent = totalScore;
    document.getElementById('total-score').style.color = tier.color;
    document.getElementById('total-max').textContent   = '/ ' + maxScore;
    document.getElementById('results-title').textContent = 'YOUR FINAL BUILD';
  } else {
    badge.textContent    = mode.icon;
    badge.style.color    = mode.color;
    badge.style.fontSize = '4rem';
    document.getElementById('results-title').textContent = mode.name.toUpperCase();
  }

  // Show/hide score + radar for non-classic
  document.getElementById('results-total').style.display         = isClassic ? '' : 'none';
  document.querySelector('.results-radar-wrapper').style.display = isClassic ? '' : 'none';

  document.getElementById('results-anime-name').textContent = currentAnime.name.toUpperCase();
  document.getElementById('results-anime-name').style.color = currentAnime.color;

  // ── Result cards ──
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

    let scoreLabel = '';
    if (isClassic) {
      const v = p.score;
      const named =
        (p.statKey === 'form'            && p.character.formName)         ? p.character.formName
      : (p.statKey === 'cursedTechnique' && p.character.ctName)           ? p.character.ctName
      : (p.statKey === 'breathingStyle')  ? (p.character.breathingName  || 'None')
      : (p.statKey === 'devilFruit')      ? (p.character.devilFruitName || 'None')
      : (p.statKey === 'haki')            ? (p.character.hakiName       || 'None')
      : (p.statKey === 'domainExpansion') ? (p.character.domainName     || 'None')
      : (p.statKey === 'chakra')          ? (p.character.chakraName     || 'None')
      : (p.statKey === 'mainJutsu')       ? (p.character.jutsuName      || 'None')
      : (p.statKey === 'eyes')            ? (p.character.eyeName        || 'None')
      : (p.statKey === 'quirk')           ? (p.character.quirkName      || 'None')
      : (p.statKey === 'reiatsu')         ? (p.character.reiName        || 'None')
      : (p.statKey === 'zanpakuto')       ? (p.character.zanpakutoName  || 'None')
      : (p.statKey === 'bankai')          ? (p.character.bankaiName     || 'None')
      : (p.statKey === 'nen')             ? (p.character.nenType        || 'None')
      : (p.statKey === 'hatsu')           ? (p.character.hatsuName      || 'None')
      : (p.statKey === 'devilPower')      ? (p.character.devilName      || 'None')
      : (p.statKey === 'contract')        ? (p.character.contractName   || 'None')
      : (p.statKey === 'heroRank')        ? (p.character.rankName       || 'None')
      : (p.statKey === 'magic')           ? (p.character.magicName      || 'None')
      : (p.statKey === 'grimoire')        ? (p.character.grimoireName   || 'None')
      : null;
      scoreLabel = `
        ${named ? `<div class="result-score-num" style="color:${p.statColor};font-size:0.8rem">${named}</div>` : ''}
        <div class="result-score-num" style="color:${p.statColor}">${v}/10</div>
        <div class="result-score-bar">
          <div class="result-score-fill" style="width:0%;background:${p.statColor}" data-width="${v * 10}%"></div>
        </div>`;
    }

    card.innerHTML = `
      <div class="result-stat-row">${p.statIcon} ${p.stat.toUpperCase()}</div>
      ${portrait}
      <div class="result-char-name">${p.character.name}</div>
      ${scoreLabel}
    `;
    grid.appendChild(card);
  });

  showScreen('screen-results');

  if (isClassic) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.querySelectorAll('.result-score-fill').forEach(el => {
        el.style.width = el.dataset.width;
      });
    }));
    setTimeout(() => drawRadar(pickedChars), 300);
  }
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
