import readline from 'readline';
import chalk from 'chalk';
import { ensureBinaries } from './installer.js';
import { searchYouTube, getAudioStreamUrl, isYouTubeLink, getAutoTracks, resolveVideoId, randomFresh, nextAutoMode, autoModeLabel } from './yt-service.js';
import { AudioPlayer } from './audio-player.js';
import { renderUI, formatTime, SETTINGS_ROWS } from './tui-renderer.js';
import { swapQueueItems, deleteQueueItem } from './queue-edit.js';
import { applySpecSpeed, SPEC_SPEED_ORDER, specSpeedLabel, specDropFor } from './spectrum.js';

// Application State
let mode = 'SEARCH'; // 'SEARCH', 'RESULTS', 'PLAYER'
let input = null; // editor sebaris aktif { purpose:'search', label, buf, cursor } atau null
let searchQuery = '';
let searchResults = [];
let selectedIndex = 0;
let queue = [];
let autoFeed = true; // ponytail: autoplay similar tracks when the queue runs out (queue always wins)
let autoMode = 'mix'; // 'mix' | 'acak' | 'artis' | 'channel' — what "next" means (Settings [s])
let specSpeed = 'cepat'; // spectrum bar fall speed: 'lambat' | 'normal' | 'cepat' (Settings [s], default kencang)
let specDrop = specDropFor(specSpeed); // ikut mode: lambat/normal drop, cepat tanpa drop
let playHistory = new Set(); // videoIds already heard — autoplay never repeats these
let autoCache = { forId: null, mode: 'mix', tracks: [], pick: null }; // prefetched candidates
let settingsIndex = 0; // selected row in SETTINGS mode
let settingsPrevMode = 'PLAYER'; // where [Esc] returns to
let qeIndex = 0; // cursor in QUEUEEDIT mode
let qeMark = null; // marked index for swap, null = none
let qePrevMode = 'PLAYER'; // where [Esc] returns to
let prefetchGen = 0; // stale prefetch results (track changed mid-fetch) are discarded
let statusMessage = '';
let uiRefreshInterval = null;
let lastDrawnSec = -1;

const player = new AudioPlayer();
applySpecSpeed(player.analyzer, specSpeed); // default kencang
player.dropOnEnd = specDrop;

// Initialize terminal input
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true); // mentah selamanya — prompt digambar sendiri per karakter
}
if (process.stdout.isTTY) process.stdout.write('\x1b[?2004l'); // paste polos, sekali di awal

function updateUI() {
  // satu penulis layar (tanpa readline) — repaint kapan pun aman, termasuk saat mengetik
  renderUI({
    mode,
    query: searchQuery,
    results: searchResults,
    selectedIndex,
    player,
    queue,
    autoFeed,
    autoNext: peekAutoNext(),
    settings: { autoFeed, autoMode, volume: player.volume, specSpeed, specDrop },
    settingsIndex,
    queueEdit: mode === 'QUEUEEDIT' ? { index: qeIndex, mark: qeMark } : null,
    input,
    statusMessage,
  });
}

function startUIRefreshLoop() {
  if (!uiRefreshInterval) {
    uiRefreshInterval = setInterval(() => {
      if (player.state === 'PLAYING' || player.state === 'LOADING') {
        updateUI();
      }
    }, 100); // 10 FPS: smooth spectrum & progress bar (in-place repaint, no flicker)
  }
}

// ponytail: prefetch next-track candidates in the background while the song plays,
// so the handoff is instant. Silent on failure — the on-demand fetch covers it.
function prefetchAuto(track) {
  if (!autoFeed) return;
  const id = resolveVideoId(track);
  if (!id) return;
  const myGen = ++prefetchGen;
  const myMode = autoMode;
  autoCache = { forId: null, mode: myMode, tracks: [], pick: null }; // invalidate old candidates
  getAutoTracks(track, 8, myMode).then((candidates) => {
    if (myGen !== prefetchGen) return; // track changed mid-fetch — stale
    if (resolveVideoId(player.currentTrack) !== id || autoMode !== myMode) return;
    const exclude = new Set(playHistory);
    for (const q of queue) {
      const qid = resolveVideoId(q);
      if (qid) exclude.add(qid);
    }
    // ponytail: acak locks its random pick now so UP NEXT doesn't flicker every render
    const pick = myMode === 'acak' ? randomFresh(candidates, exclude) : pickFresh(candidates, exclude);
    autoCache = { forId: id, mode: myMode, tracks: candidates, pick: pick || null };
    updateUI(); // UP NEXT text appears once loaded
  }).catch(() => { /* silent */ });
}

// ponytail: first candidate not heard and not sitting in the queue
function pickFresh(candidates, exclude) {
  return (candidates || []).find((t) => !exclude.has(resolveVideoId(t)));
}

// ponytail: what autoplay would play next — computed at render time so queue
// edits mid-song are reflected. Null when the queue (which always wins) has items.
function peekAutoNext() {
  if (!autoFeed || mode === 'RESULTS' || mode === 'SETTINGS' || mode === 'QUEUEEDIT') return null;
  if (!player.currentTrack || queue.length > 0) return null;
  const curId = resolveVideoId(player.currentTrack);
  if (autoCache.forId !== curId || autoCache.mode !== autoMode) return null;
  const exclude = new Set(playHistory);
  if (autoCache.pick && !exclude.has(resolveVideoId(autoCache.pick))) return autoCache.pick;
  return pickFresh(autoCache.tracks, exclude) || null; // ordered fallback, never flickers
}

// ponytail: settings menu — remembers where it was opened from for [Esc]
function openSettings() {
  if (mode !== 'SETTINGS') settingsPrevMode = mode;
  settingsIndex = 0;
  mode = 'SETTINGS';
  updateUI();
}

function closeSettings() {
  const back = ['SEARCH', 'RESULTS', 'PLAYER'].includes(settingsPrevMode) ? settingsPrevMode : null;
  mode = back || (player.currentTrack ? 'PLAYER' : 'SEARCH');
  if (mode === 'RESULTS' && searchResults.length === 0) mode = player.currentTrack ? 'PLAYER' : 'SEARCH';
  updateUI();
}

async function playTrackItem(track, isAuto = false) {
  try {
    statusMessage = `Fetching audio stream for "${track.title}"...`;
    player.state = 'LOADING';
    updateUI();

    const streamUrl = await getAudioStreamUrl(track.url);
    if (!streamUrl) {
      statusMessage = `Failed to get audio stream for ${track.title}`;
      updateUI();
      return;
    }

    // ponytail: record identity so autoplay never replays it (cap 300, oldest evicted)
    const id = resolveVideoId(track);
    if (id) {
      playHistory.add(id);
      if (playHistory.size > 300) playHistory.delete(playHistory.values().next().value);
    }
    statusMessage = isAuto ? `Auto: ${track.title}` : `Now playing: ${track.title}`;
    lastDrawnSec = -1;
    await player.playTrack(track, streamUrl, 0);
    mode = 'PLAYER';
    updateUI();
    prefetchAuto(track); // candidates for the NEXT handoff load while this song plays
  } catch (err) {
    statusMessage = `Error: ${err.message}`;
    updateUI();
  }
}

async function handleNextTrack() {
  // ponytail: queue always wins — autoplay only fills the gap when the queue is empty
  if (queue.length > 0) {
    const nextTrack = queue.shift();
    await playTrackItem(nextTrack);
    return;
  }
  if (autoFeed && player.currentTrack) {
    const exclude = new Set(playHistory);
    for (const q of queue) {
      const qid = resolveVideoId(q);
      if (qid) exclude.add(qid);
    }
    // ponytail: prefetched candidates first — instant handoff, no waiting.
    // Exclude at pick time (not fetch time) since queue/history moved while playing.
    const curId = resolveVideoId(player.currentTrack);
    if (autoCache.forId === curId && autoCache.mode === autoMode && autoCache.tracks.length > 0) {
      let pick = null;
      if (autoCache.pick && !exclude.has(resolveVideoId(autoCache.pick))) pick = autoCache.pick;
      else pick = autoMode === 'acak' ? randomFresh(autoCache.tracks, exclude) : pickFresh(autoCache.tracks, exclude);
      if (pick) {
        await playTrackItem(pick, true);
        return;
      }
    }
    statusMessage = 'Queue empty — finding a similar track...';
    player.state = 'LOADING';
    updateUI();
    try {
      const candidates = await getAutoTracks(player.currentTrack, 8, autoMode);
      const pick = autoMode === 'acak' ? randomFresh(candidates, exclude) : pickFresh(candidates, exclude);
      if (pick) {
        await playTrackItem(pick, true);
        return;
      }
      statusMessage = 'Auto-feed found nothing new — queue finished.';
    } catch (err) {
      statusMessage = `Auto-feed failed: ${err.message}`;
    }
    player.stop();
    updateUI();
    return;
  }
  statusMessage = 'Queue finished.';
  player.stop();
  updateUI();
}

player.on('ended', () => {
  handleNextTrack();
});

player.on('timeupdate', () => {
  // ponytail: throttle redraw to 1x/sec, mpv time-pos events can spam per second
  const s = Math.floor(player.currentTime);
  if (s !== lastDrawnSec) {
    lastDrawnSec = s;
    updateUI();
  }
});

player.on('error', (err) => {
  statusMessage = `Audio player error: ${err.message}`;
  updateUI();
});

player.on('volumeChange', () => {
  updateUI();
});

// Prompt pencarian: editor sebaris (tanpa readline). Satu penulis layar →
// ketikan/backspace/paste tak bisa balapan dengan repaint, dan stdin tak pernah macet.
function promptSearch() {
  if (input) return; // cegah prompt ganda (mashing f)
  input = { purpose: 'search', label: 'Cari / tempel link (Esc=batal): ', buf: '', cursor: 0 };
  updateUI();
}

async function submitSearch(raw) {
  // strip bracketed-paste markers & ANSI jika terminal masih mengirimnya saat paste link
  const queryStr = String(raw ?? '').replace(/\x1b\[200~|\x1b\[201~|\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
  if (!queryStr) {
    statusMessage = 'Search cancelled.';
    updateUI();
    return;
  }

  searchQuery = queryStr;
  statusMessage = `Searching YouTube for "${queryStr}"...`;
  updateUI();

  try {
    searchResults = await searchYouTube(queryStr);
    if (searchResults.length === 0) {
      statusMessage = `No results for "${queryStr}"`;
      mode = 'SEARCH';
    } else {
      // ponytail: link tidak auto-play — tinjau dulu (Enter=putar, a=antrean)
      mode = 'RESULTS';
      selectedIndex = 0;
      statusMessage = isYouTubeLink(queryStr)
        ? `Link ditemukan: "${searchResults[0].title}" — [Enter] Putar langsung, [a] Masuk antrean`
        : `Found ${searchResults.length} results. Pick a song to play.`;
    }
  } catch (err) {
    statusMessage = `Search failed: ${err.message}`;
    mode = 'SEARCH';
  }
  updateUI();
}

// Layar edit antrean pakai panah (tanpa ketik, tanpa prompt): ingat asal untuk [Esc]
function openQueueEdit() {
  if (queue.length === 0) {
    statusMessage = 'Queue is empty — add some with [f] then [a] first.';
    updateUI();
    return;
  }
  if (player.state === 'PLAYING') {
    player.pause();
  } else if (player.state === 'LOADING') {
    statusMessage = 'Wait for the song to start before editing the queue.';
    updateUI();
    return;
  }
  if (mode !== 'QUEUEEDIT') qePrevMode = mode;
  qeIndex = 0;
  qeMark = null;
  mode = 'QUEUEEDIT';
  updateUI();
}

function closeQueueEdit() {
  const back = ['SEARCH', 'RESULTS', 'PLAYER'].includes(qePrevMode) ? qePrevMode : null;
  mode = back || (player.currentTrack ? 'PLAYER' : 'SEARCH');
  if (mode === 'RESULTS' && searchResults.length === 0) mode = player.currentTrack ? 'PLAYER' : 'SEARCH';
  qeMark = null;
  updateUI();
}

// Handle Keyboard Inputs
process.stdin.on('keypress', async (str, key) => {
  if (!key) return;
  // Mode ketik: editor sebaris milik sendiri. Semua kunci lain ditelan selama mengetik.
  // (Ctrl+C tetap keluar via handler quit di bawah.)
  if (input) {
    const chars = [...input.buf];
    if (key.name === 'escape') {
      input = null;
      statusMessage = 'Search cancelled.';
      updateUI();
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const buf = input.buf;
      input = null;
      submitSearch(buf);
      return;
    }
    if (key.name === 'backspace') {
      if (input.cursor > 0) {
        chars.splice(input.cursor - 1, 1);
        input.buf = chars.join('');
        input.cursor--;
      }
      updateUI();
      return;
    }
    if (key.name === 'delete') {
      if (input.cursor < chars.length) {
        chars.splice(input.cursor, 1);
        input.buf = chars.join('');
      }
      updateUI();
      return;
    }
    if (key.name === 'left') {
      input.cursor = Math.max(0, input.cursor - 1);
      updateUI();
      return;
    }
    if (key.name === 'right') {
      input.cursor = Math.min(chars.length, input.cursor + 1);
      updateUI();
      return;
    }
    if (key.ctrl && key.name === 'u') {
      input.buf = '';
      input.cursor = 0;
      updateUI();
      return;
    }
    if (typeof str === 'string' && str.length === 1 && str >= ' ' && !key.ctrl && !key.meta) {
      chars.splice(input.cursor, 0, str);
      input.buf = chars.join('');
      input.cursor++;
      updateUI();
      return;
    }
    return; // telan sisanya (panah atas/bawah dsb.) selama mengetik
  }
  // Exit application (Ctrl+C or 'q')
  if ((key.ctrl && key.name === 'c') || key.name === 'q') {
    player.stop();
    if (uiRefreshInterval) clearInterval(uiRefreshInterval);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
    console.log(chalk.bold.green('Thanks for using YouTube Terminal Player! See you.'));
    process.exit(0);
  }

  // Hotkey 'f' -> Search new track (auto-pause first: UI redraws would wipe the prompt while audio runs)
  if (key.name === 'f') {
    if (player.state === 'PLAYING') {
      player.pause();
      statusMessage = 'Auto-paused — go ahead and search/add songs.';
      updateUI();
    } else if (player.state === 'LOADING') {
      statusMessage = 'Wait for the song to start before searching.';
      updateUI();
      return;
    }
    promptSearch();
    return;
  }

  // Hotkey 't' -> Auto-feed toggle (works in every mode, like 'f'; not in QUEUEEDIT where [t] = tukar)
  if (key.name === 't' && mode !== 'QUEUEEDIT') {
    autoFeed = !autoFeed;
    statusMessage = autoFeed
      ? 'Auto-feed ON — similar tracks play when the queue runs out.'
      : 'Auto-feed OFF — playback stops when the queue ends.';
    updateUI();
    // ponytail: toggled on mid-song → start loading candidates now so they're ready
    if (autoFeed && player.currentTrack && player.state === 'PLAYING') prefetchAuto(player.currentTrack);
    return;
  }

  // Hotkey 'v' -> Refresh spectrum (restarts stuck analysis, mpv untouched)
  if (key.name === 'v') {
    if (player.state === 'PLAYING' && player.streamUrl) {
      player.refreshSpectrum();
      statusMessage = 'Spectrum refreshed from the song position.';
    } else {
      statusMessage = 'Spectrum only runs while a song is playing.';
    }
    updateUI();
    return;
  }

  // Hotkey 's' -> Settings menu (works in every mode, like 'f'; not in QUEUEEDIT)
  if (key.name === 's' && mode !== 'SETTINGS' && mode !== 'QUEUEEDIT') {
    openSettings();
    return;
  }

  // Hotkey +/- -> Volume (global, works in every mode except prompt)
  if (str === '+' || str === '=' || key.name === 'equal' || key.name === 'plus') {
    const v = player.adjustVolume(5);
    statusMessage = `Volume: ${v}%`;
    updateUI();
    return;
  }
  if (str === '-' || str === '_' || key.name === 'minus' || key.name === 'underscore') {
    const v = player.adjustVolume(-5);
    statusMessage = `Volume: ${v}%`;
    updateUI();
    return;
  }

  // Settings mode navigation
  if (mode === 'SETTINGS') {
    if (key.name === 'up') {
      settingsIndex = (settingsIndex + SETTINGS_ROWS.length - 1) % SETTINGS_ROWS.length;
      updateUI();
      return;
    }
    if (key.name === 'down') {
      settingsIndex = (settingsIndex + 1) % SETTINGS_ROWS.length;
      updateUI();
      return;
    }
    if (key.name === 'escape' || key.name === 's') {
      statusMessage = '';
      closeSettings();
      return;
    }
    if (key.name === 'left' || key.name === 'right' || key.name === 'return' || key.name === 'enter') {
      const rowId = SETTINGS_ROWS[settingsIndex];
      if (rowId === 'volume') {
        const delta = key.name === 'left' ? -5 : 5;
        // enter on volume also bumps +5 (consistent)
        const v = player.adjustVolume(delta);
        statusMessage = `Volume: ${v}%`;
      } else if (rowId === 'autofeed') {
        autoFeed = !autoFeed;
        statusMessage = autoFeed
          ? 'Auto-feed ON — similar tracks play when the queue runs out.'
          : 'Auto-feed OFF — playback stops when the queue ends.';
      } else if (rowId === 'mode') {
        autoMode = nextAutoMode(autoMode);
        statusMessage = `Auto-feed mode: ${autoModeLabel(autoMode)}.`;
      } else if (rowId === 'spectrum') {
        specSpeed = SPEC_SPEED_ORDER[(SPEC_SPEED_ORDER.indexOf(specSpeed) + 1) % SPEC_SPEED_ORDER.length];
        applySpecSpeed(player.analyzer, specSpeed);
        specDrop = specDropFor(specSpeed);
        player.dropOnEnd = specDrop;
        statusMessage = `Spectrum: ${specSpeedLabel(specSpeed)} (${specDrop ? 'drop saat selesai' : 'tanpa drop'}).`;
      } else {
        statusMessage = '';
        closeSettings();
        return;
      }
      // ponytail: changed mid-song → reload candidates now so UP NEXT is fresh
      if (autoFeed && player.currentTrack && player.state === 'PLAYING') prefetchAuto(player.currentTrack);
      else autoCache = { forId: null, mode: autoMode, tracks: [], pick: null };
      updateUI();
      return;
    }
    return; // swallow all other keys in settings
  }

  // Queue-edit mode: arrow navigation, no typing (like SETTINGS)
  if (mode === 'QUEUEEDIT') {
    if (key.name === 'up') {
      qeIndex = (qeIndex + queue.length - 1) % queue.length;
      updateUI();
      return;
    }
    if (key.name === 'down') {
      qeIndex = (qeIndex + 1) % queue.length;
      updateUI();
      return;
    }
    if (key.name === 'escape') {
      closeQueueEdit();
      return;
    }
    if (key.name === 't') {
      if (qeMark == null) {
        qeMark = qeIndex;
        statusMessage = `Ditandai: "${queue[qeMark].title}" — arahkan kursor lalu [t] untuk tukar.`;
      } else if (qeMark === qeIndex) {
        qeMark = null;
        statusMessage = 'Tanda dibatalkan.';
      } else {
        const r = swapQueueItems(queue, qeMark + 1, qeIndex + 1);
        queue = r.list;
        statusMessage = r.message;
        qeMark = null;
      }
      updateUI();
      return;
    }
    if (key.name === 'h' || key.name === 'x' || key.name === 'delete' || key.name === 'backspace') {
      const r = deleteQueueItem(queue, qeIndex + 1);
      queue = r.list;
      statusMessage = r.message;
      qeMark = null;
      if (queue.length === 0) {
        closeQueueEdit();
        return;
      }
      qeIndex = Math.min(qeIndex, queue.length - 1);
      updateUI();
      return;
    }
    return; // swallow all other keys in queue-edit
  }

  // Hotkey 'd' -> Edit queue order (works in SEARCH/RESULTS/PLAYER, like 'f')
  if (key.name === 'd') {
    openQueueEdit();
    return;
  }

  // Keybindings in RESULTS mode
  if (mode === 'RESULTS') {
    if (key.name === 'up') {
      selectedIndex = (selectedIndex - 1 + searchResults.length) % searchResults.length;
      updateUI();
      return;
    }
    if (key.name === 'down') {
      selectedIndex = (selectedIndex + 1) % searchResults.length;
      updateUI();
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const selected = searchResults[selectedIndex];
      await playTrackItem(selected);
      return;
    }
    if (key.name === 'a') {
      const selected = searchResults[selectedIndex];
      queue.push(selected);
      statusMessage = `Added to queue: "${selected.title}"`;
      updateUI();
      return;
    }
    if (key.name === 'escape') {
      mode = player.currentTrack ? 'PLAYER' : 'SEARCH';
      statusMessage = '';
      updateUI();
      return;
    }
  }

  // Player controls — only active with a loaded track (PLAYER mode)
  // ponytail: just space/r/n — pause & replay via mpv IPC, stream never restarts/jumps
  if (mode !== 'PLAYER') return;
  if (key.name === 'space') {
    player.togglePlayPause();
    updateUI();
    return;
  }
  if (key.name === 'left') {
    player.seek(-10);
    statusMessage = `Back 10s → ${formatTime(player.currentTime)} / ${formatTime(player.duration)}`;
    updateUI();
    return;
  }
  if (key.name === 'right') {
    player.seek(10);
    statusMessage = `Forward 10s → ${formatTime(player.currentTime)} / ${formatTime(player.duration)}`;
    updateUI();
    return;
  }
  if (key.name === 'r') {
    player.replay();
    statusMessage = 'Replaying from the start';
    updateUI();
    return;
  }
  if (key.name === 'n') {
    statusMessage = 'Skipping to next track...';
    await handleNextTrack();
    return;
  }
});

// App Startup
async function main() {
  console.log(chalk.cyan('Checking binary dependencies (yt-dlp & mpv)...'));
  await ensureBinaries();

  startUIRefreshLoop();

  // Check if CLI query argument passed e.g.: node src/index.js "lofi beats"
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const initialQuery = args.join(' ');
    searchQuery = initialQuery;
    statusMessage = `Searching YouTube for "${initialQuery}"...`;
    updateUI();
    try {
      searchResults = await searchYouTube(initialQuery);
      if (searchResults.length > 0) {
        // ponytail: link arg juga tinjau dulu — tidak auto-play
        statusMessage = isYouTubeLink(initialQuery)
          ? `Link ditemukan: "${searchResults[0].title}" — [Enter] Putar langsung, [a] Masuk antrean`
          : `Found ${searchResults.length} results. Pick a song to play.`;
        mode = 'RESULTS';
        selectedIndex = 0;
      } else {
        mode = 'SEARCH';
      }
    } catch (err) {
      statusMessage = `Search failed: ${err.message}`;
    }
    updateUI();
  } else {
    updateUI();
    promptSearch();
  }
}

main().catch((err) => {
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
