import yts from 'yt-search';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getBinaryPaths } from './installer.js';

const execFileAsync = promisify(execFile);

// ponytail: yts() without a timeout can hang forever → locked prompt → only Ctrl+C works.
// (Promise.race already attaches handlers to every contestant, so the loser never becomes an unhandled rejection.)
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out (${ms / 1000}s), try again`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ponytail: the single definition of "that's a youtube link", used by search + direct play + CLI arg
export function isYouTubeLink(q) {
  const s = String(q || '').trim();
  return s.includes('youtube.com/') || s.includes('youtu.be/') ||
    s.includes('youtube-nocookie.com/') || /^[A-Za-z0-9_-]{11}$/.test(s);
}

function toWatchUrl(q) {
  const s = String(q || '').trim();
  // ponytail: raw 11-char ID (from "Copy video ID") -> full watch URL
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return `https://www.youtube.com/watch?v=${s}`;
  return s;
}

export async function searchYouTube(query, maxResults = 10) {
  // If query is a direct YouTube link
  if (isYouTubeLink(query)) {
    const info = await getDirectVideoInfo(toWatchUrl(query));
    return [info];
  }

  const res = await withTimeout(yts(query), 20000, 'YouTube search');
  const videos = res.videos.slice(0, maxResults).map((v) => ({
    title: v.title,
    url: v.url,
    videoId: v.videoId,
    duration: v.timestamp || 'N/A',
    durationSeconds: v.seconds || 0,
    // ponytail: author is sometimes a string / undefined, never .name directly
    author: v.author?.name ?? (typeof v.author === 'string' ? v.author : 'Unknown'),
    channelUrl: v.author?.url ?? null,
    views: v.views != null ? Number(v.views).toLocaleString() : 'N/A',
  }));

  return videos;
}

export async function getDirectVideoInfo(url) {
  const { ytDlpPath } = getBinaryPaths();
  try {
    // ponytail: --no-playlist so &list=/playlist links don't dump dozens of JSON docs (JSON.parse would throw)
    const { stdout } = await execFileAsync(ytDlpPath, ['--dump-json', '--no-warnings', '--no-playlist', url], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    const firstLine = stdout.trim().split('\n').find((l) => l.trim().startsWith('{'));
    const data = JSON.parse(firstLine);
    return {
      title: data.title || 'Unknown Title',
      url: data.webpage_url || url,
      videoId: data.id,
      duration: data.duration_string || 'N/A',
      durationSeconds: data.duration || 0,
      author: data.uploader || data.channel || 'Unknown',
      channelUrl: data.channel_url || data.uploader_url || null,
      views: data.view_count ? data.view_count.toLocaleString() : 'N/A',
    };
  } catch (err) {
    return {
      title: 'YouTube Track',
      url: url,
      videoId: 'link',
      duration: 'N/A',
      durationSeconds: 0,
      author: 'YouTube',
      channelUrl: null,
      views: 'N/A',
    };
  }
}

export async function getAudioStreamUrl(videoUrl) {
  const { ytDlpPath } = getBinaryPaths();
  // Extract direct audio URL (prefer m4a/webm opus bestaudio)
  const args = [
    '-g',
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '--no-warnings',
    '--no-playlist',
    videoUrl,
  ];

  const { stdout } = await execFileAsync(ytDlpPath, args, { timeout: 30000 });
  const streamUrl = stdout.trim().split('\n')[0];
  if (!streamUrl.startsWith('http')) throw new Error('yt-dlp did not return a valid stream URL');
  return streamUrl;
}

// ponytail: the single definition of a track's identity — dedupe key for queue/history/autoplay
export function resolveVideoId(t) {
  const s = typeof t === 'string' ? t : (t?.videoId || t?.url || '');
  const str = String(s || '');
  const m = str.match(/(?:[?&]v=|\/)([A-Za-z0-9_-]{11})(?:[?&#]|$)/) || str.match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}

function fmtFlatDuration(d) {
  if (typeof d.duration === 'number' && d.duration > 0) {
    const m = Math.floor(d.duration / 60);
    const s = Math.floor(d.duration % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  if (d.duration_string) return d.duration_string;
  return 'N/A';
}

// ponytail: autoplay modes — what "next" means. Cycled from Settings ([s]).
export const AUTOFEED_MODES = [
  { id: 'mix', label: 'Related Mix' },     // YouTube's Up-Next mix for the track
  { id: 'acak', label: 'Random' },          // random pick from that mix
  { id: 'artis', label: 'Same Artist' },    // search the same artist name
  { id: 'channel', label: 'Same Channel' }, // latest uploads of the track's channel
];

export function nextAutoMode(id) {
  const i = AUTOFEED_MODES.findIndex((m) => m.id === id);
  return AUTOFEED_MODES[(i + 1 + AUTOFEED_MODES.length) % AUTOFEED_MODES.length].id;
}

export function autoModeLabel(id) {
  return (AUTOFEED_MODES.find((m) => m.id === id) || AUTOFEED_MODES[0]).label;
}

// ponytail: random fresh pick (acak mode) — the stored pick stays stable for display
export function randomFresh(candidates, exclude) {
  const fresh = (candidates || []).filter((t) => !exclude.has(resolveVideoId(t)));
  if (fresh.length === 0) return null;
  return fresh[Math.floor(Math.random() * fresh.length)];
}

// ponytail: YouTube's own "Mix" (RD playlist) for a video — same source as Up Next.
async function fetchMix(id, want) {
  const { ytDlpPath } = getBinaryPaths();
  const mixUrl = `https://www.youtube.com/watch?v=${id}&list=RD${id}`;
  const { stdout } = await withTimeout(
    execFileAsync(ytDlpPath, ['--dump-json', '--flat-playlist', '--no-warnings', '--playlist-end', String(want), mixUrl], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }),
    35000,
    'Auto-feed'
  );
  const out = [];
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let d;
    try { d = JSON.parse(s); } catch { continue; }
    if (!d.id || d.id === id) continue;
    out.push({
      title: d.title || 'Unknown Title',
      url: d.webpage_url || d.url || `https://www.youtube.com/watch?v=${d.id}`,
      videoId: d.id,
      duration: fmtFlatDuration(d),
      durationSeconds: typeof d.duration === 'number' ? d.duration : 0,
      author: d.uploader || d.channel || 'Unknown',
      channelUrl: d.channel_url || d.uploader_url || null,
      views: d.view_count ? Number(d.view_count).toLocaleString() : 'N/A',
    });
    if (out.length >= want) break;
  }
  return out;
}

async function autoByArtist(track, id, maxResults) {
  const q = track?.author && track.author !== 'Unknown' ? String(track.author) : '';
  if (!q) return [];
  const res = await searchYouTube(q, 10);
  return res.filter((t) => resolveVideoId(t) !== id).slice(0, maxResults);
}

const channelUploadsCache = new Map(); // videoId -> ".../videos" uploads URL

// ponytail: channel uploads URL — from the track when known, else one info lookup (cached)
async function resolveChannelUploadsUrl(track, id) {
  const direct = String(track?.channelUrl || '').replace(/\/$/, '');
  if (direct) return direct + '/videos';
  if (channelUploadsCache.has(id)) return channelUploadsCache.get(id);
  try {
    const { ytDlpPath } = getBinaryPaths();
    const pageUrl = track?.url?.startsWith('http') ? track.url : `https://www.youtube.com/watch?v=${id}`;
    const { stdout } = await withTimeout(
      execFileAsync(ytDlpPath, ['--dump-json', '--skip-download', '--no-warnings', '--no-playlist', pageUrl], { timeout: 25000, maxBuffer: 8 * 1024 * 1024 }),
      28000,
      'Channel lookup'
    );
    const line = stdout.trim().split('\n').find((l) => l.trim().startsWith('{'));
    const d = JSON.parse(line);
    const base = String(d.channel_url || d.uploader_url || '').replace(/\/$/, '');
    if (!base) return null;
    const uploads = base + '/videos';
    channelUploadsCache.set(id, uploads);
    if (channelUploadsCache.size > 100) channelUploadsCache.delete(channelUploadsCache.keys().next().value);
    return uploads;
  } catch {
    return null;
  }
}

async function autoByChannel(track, id, maxResults) {
  const uploadsUrl = await resolveChannelUploadsUrl(track, id);
  if (!uploadsUrl) return [];
  const { ytDlpPath } = getBinaryPaths();
  const want = Math.max(maxResults + 4, 12);
  const { stdout } = await withTimeout(
    execFileAsync(ytDlpPath, ['--dump-json', '--flat-playlist', '--no-warnings', '--playlist-end', String(want), uploadsUrl], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }),
    35000,
    'Auto-feed'
  );
  const out = [];
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let d;
    try { d = JSON.parse(s); } catch { continue; }
    if (!d.id || d.id === id) continue;
    out.push({
      title: d.title || 'Unknown Title',
      url: d.webpage_url || d.url || `https://www.youtube.com/watch?v=${d.id}`,
      videoId: d.id,
      duration: fmtFlatDuration(d),
      durationSeconds: typeof d.duration === 'number' ? d.duration : 0,
      author: d.uploader || d.channel || track.author || 'Unknown',
      channelUrl: d.channel_url || d.uploader_url || track.channelUrl || null,
      views: d.view_count ? Number(d.view_count).toLocaleString() : 'N/A',
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

export async function getAutoTracks(track, maxResults = 8, mode = 'mix') {
  const id = resolveVideoId(track);
  if (!id) return [];
  try {
    if (mode === 'artis') return await autoByArtist(track, id, maxResults);
    if (mode === 'channel') {
      const up = await autoByChannel(track, id, maxResults);
      if (up.length > 0) return up;
      return await autoByArtist(track, id, maxResults); // fallback: same voice, other videos
    }
    // mix + acak share the RD mix source (acak just picks randomly); acak wants a bigger pool
    return await fetchMix(id, mode === 'acak' ? Math.max(maxResults + 8, 16) : Math.max(maxResults + 4, 10));
  } catch {
    if (mode === 'mix' || mode === 'acak') {
      // fallback: same artist search (mix empty/blocked) — never the current track itself
      try {
        return await autoByArtist(track, id, maxResults);
      } catch {
        return [];
      }
    }
    return [];
  }
}
