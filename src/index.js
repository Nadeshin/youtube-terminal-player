import readline from 'readline';
import chalk from 'chalk';
import { ensureBinaries } from './installer.js';
import { searchYouTube, getAudioStreamUrl, isYouTubeLink } from './yt-service.js';
import { AudioPlayer } from './audio-player.js';
import { renderUI, formatTime, requestFullRepaint } from './tui-renderer.js';

// Application State
let mode = 'SEARCH'; // 'SEARCH', 'RESULTS', 'PLAYER'
let isPrompting = false; // ponytail: replaces the 'SEARCH_INPUT' mode that was never actually set
let activePromptRl = null; // readline currently asking — force-cancellable via Esc when stuck
let searchQuery = '';
let searchResults = [];
let selectedIndex = 0;
let queue = [];
let statusMessage = '';
let uiRefreshInterval = null;
let lastDrawnSec = -1;

const player = new AudioPlayer();

// Initialize terminal input
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

function updateUI() {
  renderUI({
    mode,
    query: searchQuery,
    results: searchResults,
    selectedIndex,
    player,
    queue,
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

async function playTrackItem(track) {
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

    statusMessage = `Now playing: ${track.title}`;
    lastDrawnSec = -1;
    await player.playTrack(track, streamUrl, 0);
    mode = 'PLAYER';
    updateUI();
  } catch (err) {
    statusMessage = `Error: ${err.message}`;
    updateUI();
  }
}

async function handleNextTrack() {
  if (queue.length > 0) {
    const nextTrack = queue.shift();
    await playTrackItem(nextTrack);
  } else {
    statusMessage = 'Queue finished.';
    player.stop();
    updateUI();
  }
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

// Prompt user for search input
function promptSearch() {
  if (isPrompting) return; // ponytail: prevent double prompts (mashing f)
  isPrompting = true;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  activePromptRl = rl;

  console.log('\n');
  rl.question(chalk.bold.yellow('Title / Artist / YouTube link (Esc = cancel): '), async (input) => {
    rl.close();
    activePromptRl = null;
    isPrompting = false;
    requestFullRepaint(); // prompt leaves leftover text below the UI — one full repaint
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const queryStr = input.trim();
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
      } else if (searchResults.length === 1 && isYouTubeLink(queryStr)) {
        // Direct link play
        await playTrackItem(searchResults[0]);
        return;
      } else {
        mode = 'RESULTS';
        selectedIndex = 0;
        statusMessage = `Found ${searchResults.length} results. Pick a song to play.`;
      }
    } catch (err) {
      statusMessage = `Search failed: ${err.message}`;
      mode = 'SEARCH';
    }
    updateUI();
  });
}

// Edit queue: delete by number or all (same readline pattern as promptSearch)
function promptQueueEdit() {
  if (isPrompting) return;
  isPrompting = true;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  activePromptRl = rl;

  console.log('\n');
  rl.question(chalk.bold.yellow(`Delete queue number (1-${queue.length}) or "all" (Esc = cancel): `), (input) => {
    rl.close();
    activePromptRl = null;
    isPrompting = false;
    requestFullRepaint(); // prompt leaves leftover text below the UI — one full repaint
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const s = input.trim().toLowerCase();
    if (s === 'semua' || s === 'all' || s === '0') {
      statusMessage = `${queue.length} songs removed from the queue.`;
      queue = [];
    } else {
      const num = parseInt(s, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= queue.length) {
        const removed = queue.splice(num - 1, 1)[0];
        statusMessage = `Removed from queue: "${removed.title}"`;
      } else {
        statusMessage = 'Queue edit cancelled.';
      }
    }
    updateUI();
  });
}

// Queue-edit entry from any mode (auto-pause like 'f': prompts can't survive redraws)
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
  promptQueueEdit();
}

// Handle Keyboard Inputs
process.stdin.on('keypress', async (str, key) => {
  if (!key) return;
  // While typing in a prompt, ignore all hotkeys except Ctrl+C and Esc
  if (isPrompting) {
    if (key.ctrl && key.name === 'c') {
      player.stop();
      if (uiRefreshInterval) clearInterval(uiRefreshInterval);
      process.exit(0);
    }
    // ponytail: way out of a stuck prompt (hung search) — without this only Ctrl+C works.
    // a cancelled rl.question never calls its callback, so the flag is reset manually here.
    if (key.name === 'escape' && activePromptRl) {
      try { activePromptRl.close(); } catch { /* abaikan */ }
      activePromptRl = null;
      isPrompting = false;
      statusMessage = 'Cancelled.';
      requestFullRepaint();
      updateUI();
    }
    return;
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
    if (key.name === 'd') {
      openQueueEdit();
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
  if (key.name === 'd') {
    openQueueEdit();
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
      if (searchResults.length === 1 && isYouTubeLink(initialQuery)) {
        // ponytail: link args play immediately, don't park in RESULTS
        await playTrackItem(searchResults[0]);
        return;
      }
      if (searchResults.length > 0) {
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
