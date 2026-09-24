import chalk from 'chalk';
import { autoModeLabel } from './yt-service.js';
import { specSpeedLabel } from './spectrum.js';

// ponytail: settings rows — index.js navigates by this order (up/down + left/right)
export const SETTINGS_ROWS = ['volume', 'autofeed', 'mode', 'spectrum', 'back'];

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

// ponytail: display-width helpers — CJK/emoji occupy 2 terminal columns, so
// str.length lies and the line wraps, leaving physical-row remnants behind.
function charWidth(cp) {
  if (cp < 0x1100) return 1;
  if (cp <= 0x115f || cp === 0x2329 || cp === 0x232a) return 2;
  if (cp >= 0x2e80 && cp <= 0xa4cf) return 2;
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2;
  if (cp >= 0xf900 && cp <= 0xfaff) return 2;
  if (cp >= 0xfe10 && cp <= 0xfe19) return 2;
  if (cp >= 0xfe30 && cp <= 0xfe4f) return 2;
  if (cp >= 0xff00 && cp <= 0xff60) return 2;
  if (cp >= 0xffe0 && cp <= 0xffe6) return 2;
  if (cp >= 0x20000 && cp <= 0x3fffd) return 2;
  if (cp >= 0x1f000 && cp <= 0x1faff) return 2;
  if (cp >= 0x2600 && cp <= 0x27bf) return 2;
  return 1;
}

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

function strWidth(s) {
  let w = 0;
  for (const ch of String(s).replace(ANSI_RE, '')) w += charWidth(ch.codePointAt(0));
  return w;
}

// ponytail: hard cap a (possibly ANSI-colored) line at maxCols display columns.
// Guarantees physical rows == logical rows, so stale-row clearing stays exact.
function truncateAnsi(line, maxCols) {
  const parts = String(line).split(/(\x1B\[[0-9;]*[A-Za-z])/g);
  let w = 0;
  let out = '';
  let cut = false;
  for (const p of parts) {
    if (!p) continue;
    if (/^\x1B\[[0-9;]*[A-Za-z]$/.test(p)) { out += p; continue; }
    for (const ch of p) {
      const cw = charWidth(ch.codePointAt(0));
      if (w + cw > maxCols) { cut = true; break; }
      out += ch;
      w += cw;
    }
    if (cut) break;
  }
  return cut ? out + '\x1B[0m' : out;
}

// ponytail: status message di-wrap ke baris berikut (width-aware) —
// sebelumnya satu baris panjang kepotong truncateAnsi (mis. "Link ditemukan..." + judul panjang).
function wrapPlain(text, maxCols) {
  const words = String(text ?? '').split(/(\s+)/);
  const rows = [];
  let cur = '';
  let curW = 0;
  const pushCur = () => { if (cur) rows.push(cur); cur = ''; curW = 0; };
  for (const w of words) {
    if (!w) continue;
    if (/^\s+$/.test(w)) {
      if (curW + strWidth(w) > maxCols) pushCur();
      else { cur += w; curW += strWidth(w); }
      continue;
    }
    if (strWidth(w) > maxCols) {
      pushCur();
      let part = '';
      let partW = 0;
      for (const ch of w) {
        const cw = charWidth(ch.codePointAt(0));
        if (partW + cw > maxCols) { rows.push(part); part = ch; partW = cw; }
        else { part += ch; partW += cw; }
      }
      cur = part; curW = partW;
      continue;
    }
    if (curW + strWidth(w) > maxCols) { pushCur(); cur = w; curW = strWidth(w); }
    else { cur += w; curW += strWidth(w); }
  }
  pushCur();
  return rows.length ? rows : [''];
}

// ponytail: truncate titles so wrapping doesn't wreck narrow terminals (width-aware, surrogate-safe)
function fit(str, max = 60) {
  str = String(str ?? '');
  const w = Math.min(max, Math.max(20, (process.stdout.columns || 80) - 22));
  if (strWidth(str) <= w) return str;
  let out = '';
  let width = 0;
  for (const ch of str) {
    const cw = charWidth(ch.codePointAt(0));
    if (width + cw > w - 1) break;
    out += ch;
    width += cw;
  }
  return out + '…';
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

function volumeBar(vol) {
  const w = 10;
  const filled = Math.round((Math.max(0, Math.min(100, vol)) / 100) * w);
  const empty = w - filled;
  const bar = chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
  let pct = `${vol}%`;
  if (vol === 0) pct = chalk.dim(pct);
  else if (vol >= 100) pct = chalk.bold.white(pct);
  else pct = chalk.white(pct);
  return `[${bar}] ${pct}`;
}

export function renderUI({
  mode,             // 'SEARCH', 'RESULTS', 'PLAYER'
  query,
  results,
  selectedIndex,
  player,
  queue,
  autoFeed = true,  // autoplay similar tracks when the queue runs out
  autoNext = null,  // prefetched autoplay pick shown as UP NEXT
  settings = null,  // { autoFeed, autoMode } for the SETTINGS screen
  settingsIndex = 0,
  queueEdit = null, // { index, mark } for the QUEUEEDIT screen
  input = null, // editor sebaris { label, buf, cursor } atau null
  statusMessage
}) {
  const lines = [];

  // Header Banner
  lines.push(chalk.bold.cyan('==============================================================='));
  lines.push(chalk.bold.magenta('  🎵 YOUTUBE TERMINAL AUDIO PLAYER  ') + chalk.dim('(Audio-Only / Clean Console / v1.2.0)'));
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
    const vol = player.volume ?? 100;
    lines.push(`   Volume   : ${volumeBar(vol)}`);
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
    // (Legend block is 6 rows: separator + CONTROLS + 3 control lines + separator.)
    const chrome = 4 + (player.currentTrack ? 8 : 0) + 4 + (queue && queue.length ? 7 : 0) + (statusMessage ? 2 : 0) + 6 + 1;
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
  } else if (mode === 'SETTINGS') {
    // ponytail: settings menu — ↑/↓ moves, ←/→ changes, Esc goes back
    lines.push(chalk.bold.white('SETTINGS:'));
    lines.push(chalk.dim('   [Use ↑/↓ to move, [←/→] to change, [Esc] to close]'));
    lines.push('');
    const s = settings || { autoFeed, autoMode: 'mix', volume: 100 };
    const volDisp = `${volumeBar(s.volume ?? 100)}  ${chalk.dim('[←/→ ±5]')}`;
    const row = (i, label, value) => {
      const prefix = i === settingsIndex ? chalk.bold.green(' ➔ ') : '   ';
      const name = i === settingsIndex ? chalk.bold.yellow(label) : chalk.white(label);
      return `${prefix}${name} : ${chalk.cyan(value)}`;
    };
    lines.push(row(0, 'Volume', volDisp));
    lines.push(row(1, 'Auto-feed', s.autoFeed ? 'ON' : 'OFF'));
    lines.push(row(2, 'Auto mode', autoModeLabel(s.autoMode)));
    lines.push(row(3, 'Spectrum', `${specSpeedLabel(s.specSpeed)}  ${chalk.dim(s.specDrop === false ? '[tanpa drop]' : '[drop]')}`));
    const bp = settingsIndex === 4 ? chalk.bold.green(' ➔ ') : '   ';
    lines.push(`${bp}${settingsIndex === 4 ? chalk.bold.yellow('Back') : chalk.white('Back')}`);
    lines.push('');
  } else if (mode === 'QUEUEEDIT') {
    // layar edit antrean pakai panah — tanpa ketik, tanpa prompt
    lines.push(chalk.bold.white('EDIT ANTREAN:'));
    lines.push(chalk.dim('   [↑/↓] Pilih  [t] Tandai/Tukar  [h] Hapus  [Esc] Selesai'));
    lines.push('');
    const qe = queueEdit || { index: 0, mark: null };
    (queue || []).forEach((qItem, idx) => {
      const isCur = idx === qe.index;
      const isMark = idx === qe.mark;
      const prefix = isCur ? chalk.bold.green(' ➔ ') : '   ';
      const num = chalk.dim(`${idx + 1}.`);
      const name = isCur ? chalk.bold.underline.yellow(fit(qItem.title, 55)) : chalk.white(fit(qItem.title, 55));
      const tag = isMark ? chalk.bgCyan.black(' TUKAR ') + ' ' : '';
      lines.push(`${prefix}${tag}${num} ${name} ${chalk.dim(`[${qItem.duration || '??:??'}]`)}`);
    });
    if (qe.mark != null && queue && queue[qe.mark]) {
      lines.push('');
      lines.push(chalk.cyan(`Ditandai: "${fit(queue[qe.mark].title, 50)}" — arahkan kursor lalu [t] untuk tukar.`));
    }
    lines.push('');
  }

  // Queue View (disembunyikan di QUEUEEDIT — daftar penuh sudah tampil di atas)
  if (queue && queue.length > 0 && mode !== 'QUEUEEDIT') {
    lines.push(chalk.bold.white(`SONG QUEUE (${queue.length}):`));
    queue.slice(0, 4).forEach((qItem, idx) => {
      lines.push(chalk.dim(`   ${idx + 1}. ${fit(qItem.title, 55)} [${qItem.duration}]`));
    });
    if (queue.length > 4) {
      lines.push(chalk.dim(`   ... and ${queue.length - 4} more songs in queue`));
    }
    lines.push(chalk.dim('---------------------------------------------------------------'));
  } else if (autoFeed && player.currentTrack && mode !== 'RESULTS' && mode !== 'SETTINGS') {
    // ponytail: queue empty → show what autoplay has lined up (never in RESULTS:
    // that screen's row math leaves no room for extra lines)
    lines.push(chalk.dim('---------------------------------------------------------------'));
    if (autoNext) {
      lines.push(`UP NEXT (AUTO): ${chalk.cyan(fit(autoNext.title, 50))} ${chalk.dim(`[${autoNext.duration}]`)}`);
    } else {
      lines.push(chalk.dim('UP NEXT (AUTO): loading...'));
    }
  }

  // Status Message / Alert
  if (statusMessage) {
    const cols = process.stdout.columns || 80;
    for (const wl of wrapPlain(statusMessage, cols)) lines.push(chalk.yellow(wl));
    lines.push('');
  }

  // Kolom ketik aktif (pengganti readline): digambar penulis yang sama — tak bisa balapan
  if (input) {
    const cols = process.stdout.columns || 80;
    const label = String(input.label ?? '');
    const chars = [...String(input.buf ?? '')];
    const cursor = Math.max(0, Math.min(input.cursor ?? chars.length, chars.length));
    const maxBuf = Math.max(10, cols - strWidth(label) - 4);
    let start = 0;
    if (chars.length > maxBuf) start = Math.max(0, Math.min(cursor, chars.length - maxBuf));
    const win = chars.slice(start, start + maxBuf);
    const curInWin = Math.max(0, Math.min(cursor - start, win.length));
    const marked = (start > 0 ? '…' : '') + win.slice(0, curInWin).join('') + '█' +
      win.slice(curInWin).join('') + ((start + maxBuf < chars.length) ? '…' : '');
    lines.push('');
    lines.push(truncateAnsi(label + marked, cols));
  }

  // Hotkeys & Controls Legend
  lines.push(chalk.bold.cyan('==============================================================='));
  lines.push(chalk.bold.white('CONTROLS:'));
  if (mode === 'RESULTS') {
    lines.push(
      ` ${chalk.bold.yellow('[↑/↓]')} Select  ` +
      ` ${chalk.bold.yellow('[Enter]')} Play  ` +
      ` ${chalk.bold.yellow('[a]')} +Queue  ` +
      ` ${chalk.bold.yellow('[d]')} Edit queue`
    );
    lines.push(
      ` ${chalk.bold.yellow('[Esc]')} Back  ` +
      ` ${chalk.bold.yellow('[f]')} Search  ` +
      ` ${chalk.bold.yellow('[q]')} Quit`
    );
    lines.push(
      ` ${chalk.bold.yellow('[t]')} Auto:${autoFeed ? 'ON' : 'OFF'}  ` +
      ` ${chalk.bold.yellow('[s]')} Settings`
    );
  } else if (mode === 'QUEUEEDIT') {
    lines.push(
      ` ${chalk.bold.yellow('[↑/↓]')} Pilih  ` +
      ` ${chalk.bold.yellow('[t]')} Tukar  ` +
      ` ${chalk.bold.yellow('[h]')} Hapus  ` +
      ` ${chalk.bold.yellow('[Esc]')} Selesai`
    );
  } else {
    lines.push(
      ` ${chalk.bold.yellow('[Space]')} Play/Pause  ` +
      ` ${chalk.bold.yellow('[←/→]')} Seek 10s  ` +
      ` ${chalk.bold.yellow('[r]')} Replay`
    );
    lines.push(
      ` ${chalk.bold.yellow('[n]')} Next  ` +
      ` ${chalk.bold.yellow('[v]')} Spectrum  ` +
      ` ${chalk.bold.yellow('[f]')} Search  ` +
      ` ${chalk.bold.yellow('[d]')} Queue`
    );
    lines.push(
      ` ${chalk.bold.yellow('[+/-]')} Vol  ` +
      ` ${chalk.bold.yellow('[t]')} Auto:${autoFeed ? 'ON' : 'OFF'}  ` +
      ` ${chalk.bold.yellow('[s]')} Settings  ` +
      ` ${chalk.bold.yellow('[q]')} Quit`
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
  const cols = process.stdout.columns || 80;
  const termRows = process.stdout.rows || 24;
  // ponytail: no line may exceed the terminal width — a wrapped line occupies an
  // extra physical row that logical-row clearing can never reach (ghost separators).
  const body = lines.map((l) => truncateAnsi(l, cols) + '\x1B[K').join('\n') + '\n';
  let out;
  // fit on screen = overwrite (smooth); too tall = full clear (never duplicated).
  // (Too tall always scrolls; in-place repaint on a scrolled screen leaves old-frame remnants.)
  if (needFullClear || lines.length >= termRows) {
    needFullClear = false;
    out = '\x1B[2J\x1B[3J\x1B[H' + body;
  } else {
    out = '\x1B[H' + body;
    // stale rows cleared to the bottom of the screen (not just lastLineCount) —
    // cheap insurance against any physical/logical row mismatch.
    for (let i = lines.length; i < termRows; i++) {
      out += '\x1B[' + (i + 1) + ';1H\x1B[K';
    }
    // parkir kursor tepat di bawah UI — prompt '\n' berikutnya tidak scroll layar,
    // readline jadi pemilik barisnya sendiri dan backspace tidak makan menu.
    out += '\x1B[' + (lines.length + 1) + ';1H';
  }
  lastLineCount = lines.length;
  process.stdout.write(out);
}
