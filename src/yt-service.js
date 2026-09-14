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
