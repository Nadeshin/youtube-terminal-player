import chalk from 'chalk';

// Utility to format seconds into MM:SS or HH:MM:SS
export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = Math.floor(sec % 60);

  const pad = (n) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

// ponytail: truncate titles so wrapping doesn't wreck narrow terminals
function fit(str, max = 60) {
  str = String(str ?? '');
  const w = Math.min(max, Math.max(20, (process.stdout.columns || 80) - 22));
  return str.length > w ? str.slice(0, w - 1) + '…' : str;
}

// ponytail: 6-row vertical spectrum panel. Frozen + dimmed while paused; placeholder before any data.
function spectrumPanel(spec, active) {
  const H = 6;
  const W = 2;
  const empty = !spec || !spec.length;
  const bars = empty ? new Array(12).fill(0) : spec;
  const rows = ['   SPECTRUM:'];
  for (let r = H; r >= 1; r--) {
    let line = '   ';
    bars.forEach((v) => {
      let cell;
      if (empty) {
        cell = chalk.dim('░'.repeat(W));
      } else if (Math.round(v * H) >= r) {
        cell = (r > 4 ? chalk.red : r > 2 ? chalk.yellow : chalk.green)('█'.repeat(W));
      } else {
        cell = ' '.repeat(W);
      }
      line += cell + ' ';
    });
    rows.push(active && !empty ? line : chalk.dim(line));
  }
  return rows;
}

export function renderUI({
  mode,             // 'SEARCH', 'RESULTS', 'PLAYER'
  query,
  results,
  selectedIndex,
  player,
  queue,
  statusMessage
}) {
  const lines = [];

  // Header Banner
  lines.push(chalk.bold.cyan('==============================================================='));
  lines.push(chalk.bold.magenta('  🎵 YOUTUBE TERMINAL AUDIO PLAYER  ') + chalk.dim('(Audio-Only / Clean Console / v1.1.0)'));
  lines.push(chalk.bold.cyan('==============================================================='));
  lines.push('');

  // Player Section (if a track is loaded)
  if (player.currentTrack) {
    const track = player.currentTrack;
    const isPlaying = player.state === 'PLAYING';
    const isPaused = player.state === 'PAUSED';
    const isLoading = player.state === 'LOADING';

    let statusTag = chalk.bgGreen.black(' PLAYING ');
    if (isPaused) statusTag = chalk.bgYellow.black(' PAUSED ');
    if (isLoading) statusTag = chalk.bgCyan.black(' LOADING STREAM... ');
    if (player.state === 'STOPPED') statusTag = chalk.bgRed.white(' STOPPED ');

    // ponytail: real spectrum from the analyzer (panel below); dimmed + frozen while paused
    const spec = player.getSpectrum ? player.getSpectrum() : null;

    lines.push(chalk.bold.white('🎧 NOW PLAYING:'));
    lines.push(`   Title    : ${chalk.bold.yellow(fit(track.title))}`);
    lines.push(`   Channel  : ${chalk.cyan(track.author)}  |  Views: ${chalk.dim(track.views || 'N/A')}`);
    lines.push(`   Status   : ${statusTag}`);

    // Progress bar calculations
    const curr = player.currentTime || 0;
    const dur = player.duration || track.durationSeconds || 1;
    const percent = Math.min(1, Math.max(0, curr / dur));
    const barWidth = 30;
    const filledChars = Math.round(percent * barWidth);
    const emptyChars = barWidth - filledChars;
    const progressBar = chalk.green('█'.repeat(filledChars)) + chalk.gray('░'.repeat(emptyChars));
    
    const timeDisplay = `${formatTime(curr)} / ${formatTime(dur)}`;

    lines.push(`   Progress : [${progressBar}] ${chalk.bold.white(timeDisplay)}  (${Math.round(percent * 100)}%)`);
    // ponytail: spectrum panel only outside RESULTS — search screen needs room for the result list
    if (mode !== 'RESULTS') {
      lines.push(chalk.dim('---------------------------------------------------------------'));
      lines.push(...spectrumPanel(spec, isPlaying));
    }
    lines.push(chalk.dim('---------------------------------------------------------------'));
  }

  // Mode Specific View
  if (mode === 'SEARCH') {
    lines.push(chalk.bold.white('FIND MUSIC / YOUTUBE VIDEOS:'));
    lines.push(chalk.dim('   Type a song title / artist name or paste a YouTube link.'));
    lines.push('');
  } else if (mode === 'RESULTS') {
    lines.push(chalk.bold.white(`SEARCH RESULTS FOR: "${chalk.cyan(query)}"`));
    lines.push(chalk.dim('   [Use ↑/↓ to choose, [Enter] to Play, [a] to Queue]'));
    lines.push('');

    // ponytail: result window follows screen height — content taller than the terminal
    // scrolls every frame and duplicates the legend. The window follows the cursor.
    // (Player section here is 7 rows: spectrum panel hidden to make room for results.)
    const termRows = process.stdout.rows || 24;
    const chrome = 4 + (player.currentTrack ? 7 : 0) + 4 + (queue && queue.length ? 7 : 0) + (statusMessage ? 2 : 0) + 5 + 1;
    let maxRes = Math.max(2, termRows - chrome);
    if (results.length > maxRes) maxRes = Math.max(2, maxRes - 1); // room for the "N more" footer row
    let start = 0;
    if (selectedIndex >= maxRes) start = Math.min(selectedIndex - maxRes + 1, Math.max(0, results.length - maxRes));
    const shown = results.slice(start, start + maxRes);
    shown.forEach((item, i) => {
      const index = start + i;
      const isSelected = index === selectedIndex;
      const prefix = isSelected ? chalk.bold.green(' ➔ ') : '   ';
      const number = chalk.dim(`${index + 1}.`);
      const titleStr = isSelected ? chalk.bold.underline.yellow(fit(item.title)) : chalk.white(fit(item.title));
      const meta = chalk.dim(`[${item.duration}] • ${item.author}`);

      lines.push(`${prefix}${number} ${titleStr} ${meta}`);
    });
    const hidden = results.length - start - shown.length;
    if (hidden > 0) lines.push(chalk.dim(`   ... ${hidden} more results (↑/↓ to browse)`));
    lines.push('');
  }

  // Queue View
  if (queue && queue.length > 0) {
    lines.push(chalk.bold.white(`SONG QUEUE (${queue.length}):`));
    queue.slice(0, 4).forEach((qItem, idx) => {
      lines.push(chalk.dim(`   ${idx + 1}. ${fit(qItem.title, 55)} [${qItem.duration}]`));
    });
    if (queue.length > 4) {
      lines.push(chalk.dim(`   ... and ${queue.length - 4} more songs in queue`));
    }
    lines.push(chalk.dim('---------------------------------------------------------------'));
  }

  // Status Message / Alert
  if (statusMessage) {
    lines.push(chalk.yellow(statusMessage));
    lines.push('');
  }

  // Hotkeys & Controls Legend
  lines.push(chalk.bold.cyan('==============================================================='));
  lines.push(chalk.bold.white('CONTROLS:'));
  if (mode === 'RESULTS') {
    lines.push(
      ` ${chalk.bold.yellow('[↑/↓]')} Select  ` +
      ` ${chalk.bold.yellow('[Enter]')} Play  ` +
      ` ${chalk.bold.yellow('[a]')} +Queue  ` +
      ` ${chalk.bold.yellow('[d]')} Edit queue  `
    );
    lines.push(
      ` ${chalk.bold.yellow('[Esc]')} Back  ` +
      ` ${chalk.bold.yellow('[f]')} Search  ` +
      ` ${chalk.bold.yellow('[q]')} Quit`
    );
  } else {
    lines.push(
      ` ${chalk.bold.yellow('[Space]')} Play/Pause  ` +
      ` ${chalk.bold.yellow('[←/→]')} Seek 10s  ` +
      ` ${chalk.bold.yellow('[r]')} Replay  `
    );
    lines.push(
      ` ${chalk.bold.yellow('[n]')} Next  ` +
      ` ${chalk.bold.yellow('[v]')} Spectrum  ` +
      ` ${chalk.bold.yellow('[f]')} Search  ` +
      ` ${chalk.bold.yellow('[d]')} Queue  ` +
      ` ${chalk.bold.yellow('[q]')} Quit  `
    );
  }
  lines.push(chalk.bold.cyan('==============================================================='));

  paint(lines);
}

// ponytail: in-place repaint, not full clear. Clearing everything each frame = flicker on Windows terminals.
// Each line ends with clear-to-end-of-line (leftover long-title chars die too); uncovered rows of the
// old frame are cleared explicitly. Full clear only on demand (first paint/prompt/resize).
let needFullClear = true;
let lastLineCount = 0;

export function requestFullRepaint() {
  needFullClear = true;
}

if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('resize', () => {
    needFullClear = true;
  });
}

function paint(lines) {
  const body = lines.map((l) => l + '\x1B[K').join('\n') + '\n';
  const termRows = process.stdout.rows || 24;
  let out;
  // fit on screen = overwrite (smooth); too tall = full clear (never duplicated).
  // (Too tall always scrolls; in-place repaint on a scrolled screen leaves old-frame remnants.)
  if (needFullClear || lines.length >= termRows) {
    needFullClear = false;
    out = '\x1B[2J\x1B[3J\x1B[H' + body;
  } else {
    out = '\x1B[H' + body;
    // stale old-frame rows cleared via absolute position — newlines near the
    // bottom scroll the screen and scramble it (duplicated legend when a song starts).
    for (let i = lines.length; i < lastLineCount && i < termRows; i++) {
      out += '\x1B[' + (i + 1) + ';1H\x1B[K';
    }
  }
  lastLineCount = lines.length;
  process.stdout.write(out);
}
