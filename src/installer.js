import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT_DIR, 'bin');

export function getBinaryPaths() {
  const isWin = process.platform === 'win32';
  const ytDlpPath = path.join(BIN_DIR, isWin ? 'yt-dlp.exe' : 'yt-dlp');
  const ffmpegPath = path.join(BIN_DIR, isWin ? 'ffmpeg.exe' : 'ffmpeg');

  // ponytail: mpv audio engine (true pause via IPC). bin/ first, then system PATH.
  let mpvPath = path.join(BIN_DIR, isWin ? 'mpv.exe' : 'mpv');
  if (!fs.existsSync(mpvPath)) {
    const sys = whichMpv();
    if (sys) mpvPath = sys;
  }

  return { ytDlpPath, mpvPath, ffmpegPath };
}

function whichMpv() {
  try {
    const cmd = process.platform === 'win32' ? 'where mpv' : 'command -v mpv';
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

export async function ensureBinaries() {
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  const { ytDlpPath, mpvPath } = getBinaryPaths();
  const { ffmpegPath } = getBinaryPaths();
  const isWin = process.platform === 'win32';

  if (!fs.existsSync(ytDlpPath)) {
    console.log(chalk.yellow('Downloading yt-dlp binary...'));
    if (isWin) {
      const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
      execSync(`powershell -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${ytDlpPath}'"`);
    } else {
      const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
      execSync(`curl -L ${url} -o ${ytDlpPath} && chmod +x ${ytDlpPath}`);
    }
    console.log(chalk.green('✔ yt-dlp downloaded.'));
  }

  if (!fs.existsSync(mpvPath)) {
    console.log(chalk.yellow('Downloading mpv binary for audio streaming...'));
    try {
      if (isWin) {
        await downloadMpvWindows(path.join(BIN_DIR, 'mpv.exe'));
      } else {
        // ponytail: no mpv auto-download on linux — fail loudly instead of fake success
        throw new Error('mpv not found. Install manually: sudo apt install mpv (or brew install mpv)');
      }
    } catch (err) {
      throw new Error(`Failed to set up mpv: ${err.message}. Alternative: download at https://mpv.io/installation/ and drop mpv.exe into bin/`);
    }
    console.log(chalk.green('✔ mpv downloaded.'));
  }
}

// ponytail: GET + follow redirects (GitHub assets always 302 to object storage)
function fetchBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    import('https').then(({ default: https }) => {
      https.get(url, { headers: { 'User-Agent': 'youtube-terminal-player' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(fetchBuffer(res.headers.location, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    }).catch(reject);
  });
}

// ponytail: fetch latest zhongfly release (mpv-x86_64-v3), extract mpv.exe via built-in Windows tar.
async function downloadMpvWindows(destExe) {
  const apiUrl = 'https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest';
  const json = (await fetchBuffer(apiUrl)).toString();
  const assets = JSON.parse(json).assets || [];
  const pick = (re) => assets.find((a) => re.test(a.name));
  const asset = pick(/^mpv-x86_64-v3-.*\.7z$/) || pick(/^mpv-x86_64-.*\.7z$/);
  if (!asset) throw new Error('mpv 7z asset not found in the latest release');

  const arcPath = destExe + '.7z';
  const tmpDir = destExe + '.extract';
  fs.writeFileSync(arcPath, await fetchBuffer(asset.browser_download_url));
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync(`tar -xf "${arcPath}" -C "${tmpDir}"`, { stdio: 'inherit' });
    const found = findFileRecursive(tmpDir, 'mpv.exe');
    if (!found) throw new Error('mpv.exe not found inside the archive');
    fs.copyFileSync(found, destExe);
  } finally {
    fs.rmSync(arcPath, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function findFileRecursive(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return full;
    if (entry.isDirectory()) {
      const hit = findFileRecursive(full, name);
      if (hit) return hit;
    }
  }
  return null;
}
