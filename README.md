# 🎵 YouTube Terminal Audio Player

Play YouTube music or podcasts right from your terminal. No browser, no video, no pop-up ads — just sound.

Made for coding sessions: search a song, queue a few more, get back to work. Everything is keyboard-driven.

> **v1.2.0** — pasted links are reviewed first (no more instant play), inline search editor (pasting never glitches the prompt), visual queue editor (reorder + delete), spectrum speed setting.

## ✨ Features

- **Truly audio-only** — streams just the sound, way lighter than opening YouTube.
 - **Search or paste a link** — type a title/artist, or paste `youtube.com`, `youtu.be`, even a raw video ID or a `watch?v=...&list=...` link. Links are reviewed first (that video only, never the whole playlist): `Enter` plays it, `a` queues it.
- **Song queue** — add multiple tracks, auto-advances when one ends.
- **Auto-feed** — when the queue runs out, similar tracks keep the music going. Queue always wins, heard songs never repeat. Toggle with `t`, or open Settings with `s` to pick the mode: Related Mix, Random, Same Artist, Same Channel.
- **Full keyboard control** — play/pause, 10-second skip, replay, next, queue editing.
- **Real-time spectrum** — an FFT frequency panel that moves with the song, not a fake animation. Stuck for >1 second? It restarts itself, or press `v`.
- **Never gets stuck** — searches time out, frozen prompts can be cancelled with `Esc`. No more "only Ctrl+C works" moments.

## 🚀 Usage

Requires **Node.js 18** or newer.

```bash
git clone <your-repo-url>
cd <folder-name>
npm install
npm start
```

Start directly with a search term:

```bash
npm start -- "lofi hip hop"
```

> **First-run note:** the app auto-downloads `yt-dlp` (±17 MB) and `mpv` (±117 MB) into `bin/`, so give it a decent connection once. After that it just runs.
> The spectrum panel additionally needs `ffmpeg` in `bin/` — without it you get a placeholder instead of the bars (everything else still works).

## ⌨ Controls

| Key | Action |
| --- | ------ |
| `Space` | Play / Pause (a real pause — the song never jumps) |
| `←` / `→` | Back / forward 10 seconds |
| `r` | Replay the song from the start |
| `n` | Skip to the next track |
| `↑` / `↓` | Select a song (in search results) |
| `Enter` | Play the selected song |
| `a` | Add the selected song to the queue |
| `d` | Edit the queue (↑/↓ move, `t` mark + swap, `h`/`x` delete) |
| `t` | Toggle auto-feed (in queue editor: mark/swap instead) |
| `s` | Settings (auto-feed, mode, spectrum speed, volume) |
| `+` / `-` | Volume up / down |
| `Esc` | Leave search / cancel typing |
| `f` | Search for a new song (playing track auto-pauses) |
| `v` | Refresh the spectrum manually |
| `q` | Quit |

## 🧠 How It Works

- **Search & stream URLs:** `yt-dlp` (text search via `yt-search`).
- **Playback:** `mpv` controlled over IPC — pause, seek, and replay without restarting the stream, so no gaps or jumps.
- **Spectrum:** `ffmpeg` decodes audio in realtime → FFT in Node → 12 frequency bands.
- **Display:** 10fps in-place repaint (no flicker on Windows Terminal), result list adapts to screen height.

## ❓ Troubleshooting

- **Typing field broken / prompt glitched?** Shouldn't happen anymore — opening search (`f`) auto-pauses first. If it ever sticks, press `Esc`.
- **Search failed / timed out?** Just retry — sometimes YouTube is slow; searches are capped at 20 seconds so they never hang.
- **No sound?** Check Windows audio output isn't muted and no stray `mpv.exe` is stuck in Task Manager, then restart.
- **Spectrum frozen?** Wait 1–2 seconds (it auto-refreshes), or press `v`. Silent passages showing flat bars is normal.
- **Playlist link played the wrong song?** Paste the video URL directly (the one with `watch?v=`), not the `playlist?list=` URL.

## 📂 Project Structure

- `src/index.js` — main flow, keyboard, queue, prompts.
- `src/yt-service.js` — YouTube search & audio stream extraction.
- `src/audio-player.js` — mpv + IPC (play/pause/seek/replay).
- `src/spectrum.js` — FFT + realtime spectrum analysis.
- `src/tui-renderer.js` — terminal screen painting.
- `src/installer.js` — auto-downloads `yt-dlp` & `mpv` when missing.
- `bin/` — binaries (`yt-dlp`, `mpv`, `ffmpeg`).

---

Built for people who live in the terminal. Enjoy listening. 🎧
