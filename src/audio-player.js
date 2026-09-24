import { spawn } from 'child_process';
import net from 'net';
import EventEmitter from 'events';
import { getBinaryPaths } from './installer.js';
import { SpectrumAnalyzer } from './spectrum.js';

let ipcCounter = 0;

export class AudioPlayer extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.socket = null; // mpv IPC connection (pause/seek/position without restart)
    this._ipcBuf = '';
    this.streamUrl = null;
    this.currentTime = 0;
    this.duration = 0;
    this.state = 'STOPPED'; // 'PLAYING', 'PAUSED', 'STOPPED', 'LOADING'
    this.isManualStop = false;
    this.currentTrack = null;
    this._gen = 0; // ponytail: spawn generation id, stale events ignored
    this.analyzer = new SpectrumAnalyzer(); // realtime spectrum (off while paused/stopped)
    this.volume = 100; // 0..100, default 100%
    this.dropOnEnd = true; // spektrum di-drop saat lagu selesai (toggle di Settings)
  }

  async playTrack(track, streamUrl, startTime = 0) {
    this.stop(true);
    this.currentTrack = track;
    this.streamUrl = streamUrl;
    this.duration = track.durationSeconds || 0;
    this.currentTime = startTime;
    this.isManualStop = false;
    this.state = 'PLAYING';

    this._spawnPlayer(startTime);
    this.analyzer.drop(); // lagu baru = spektrum bersih, tanpa sisa bentuk lagu lama
    this.analyzer.start(streamUrl, startTime);
    this.emit('stateChange', this.state);
  }

  getSpectrum() {
    if (this.analyzer._wantRun) this.analyzer.offset = this.currentTime;
    return this.analyzer.levels();
  }

  _mpvSend(obj) {
    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.write(JSON.stringify(obj) + '\n');
      } catch { /* ignore: dead socket = respawn on resume */ }
    }
  }

  _spawnPlayer(startTime = 0) {
    const { mpvPath } = getBinaryPaths();
    const myGen = ++this._gen;
    const pipeName = `ytp-${process.pid}-${Date.now()}-${(ipcCounter = (ipcCounter + 1) % 100000)}`;

    const args = [
      '--no-video',
      '--no-terminal',
      `--input-ipc-server=\\\\.\\pipe\\${pipeName}`,
      `--volume=${this.volume}`,
    ];
    // ponytail: audio escape hatch (headless/CI: MPV_AO=null). Default: let mpv choose.
    if (process.env.MPV_AO) args.push(`--ao=${process.env.MPV_AO}`);
    if (startTime > 0) args.push(`--start=${Math.floor(startTime)}`);
    args.push(this.streamUrl);

    this.process = spawn(mpvPath, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    this._connectIpc(pipeName, myGen);

    this.process.on('close', () => {
      if (myGen !== this._gen) return; // spawn already replaced (fast next) — ignore
      this.process = null;
      if (this.socket) {
        try { this.socket.destroy();       } catch { /* ignore */ }
        this.socket = null;
      }
      this._onEnded();
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
    });
  }

  _connectIpc(pipeName, myGen, attempt = 0) {
    if (myGen !== this._gen || !this.process) return;
    const sock = net.createConnection(`\\\\.\\pipe\\${pipeName}`);
    let settled = false;
    const giveUp = () => {
      if (settled) return;
      settled = true;
      sock.destroy();
      // slow mpv start / missing pipe → retry while the process lives (max ~5s)
      if (myGen === this._gen && this.process && attempt < 25) {
        setTimeout(() => this._connectIpc(pipeName, myGen, attempt + 1), 200);
      }
    };
    const timer = setTimeout(giveUp, 2000);
    sock.on('connect', () => {
      clearTimeout(timer);
      settled = true;
      if (myGen !== this._gen || !this.process) {
        sock.destroy();
        return;
      }
      if (this.socket) {
        try { this.socket.destroy();       } catch { /* ignore */ }
      }
      this.socket = sock;
      this._ipcBuf = '';
      this._mpvSend({ command: ['observe_property', 1, 'time-pos'] });
      this._mpvSend({ command: ['observe_property', 2, 'volume'] });
      // ensure mpv volume matches stored value (spawn arg covers most cases, but IPC is authoritative)
      this._mpvSend({ command: ['set_property', 'volume', this.volume] });
    });
    sock.on('data', (d) => this._onIpcData(d, myGen));
    sock.on('error', giveUp);
    sock.on('close', () => {
      clearTimeout(timer);
      if (this.socket === sock) this.socket = null;
    });
  }

  _onIpcData(data, myGen) {
    if (myGen !== this._gen) return;
    this._ipcBuf += data.toString();
    let idx;
    while ((idx = this._ipcBuf.indexOf('\n')) >= 0) {
      const line = this._ipcBuf.slice(0, idx).trim();
      this._ipcBuf = this._ipcBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.event === 'property-change' && msg.name === 'time-pos' && typeof msg.data === 'number') {
        if (this.state !== 'PLAYING') continue; // ignore stale events arriving late during pause
        this.currentTime = Math.floor(msg.data);
        if (this.duration > 0 && this.currentTime > this.duration) {
          this.currentTime = this.duration;
        }
        this.emit('timeupdate', this.currentTime);
      } else if (msg.event === 'property-change' && msg.name === 'volume' && typeof msg.data === 'number') {
        this.volume = Math.round(msg.data);
        this.emit('volumeChange', this.volume);
      } else if (msg.event === 'end-file' && msg.reason === 'eof') {
        this._onEnded(myGen);
      }
    }
  }

  _onEnded(myGen) {
    if (myGen !== undefined && myGen !== this._gen) return;
    if (this.state !== 'PLAYING' || this.isManualStop) return;
    this.state = 'STOPPED';
    if (this.dropOnEnd !== false) {
      this.analyzer.stop();
      this.analyzer.drop(); // lagu selesai = spektrum langsung jatuh ke nol, tidak nari sendiri
    }
    this.emit('stateChange', this.state);
    this.emit('ended');
  }

  _alive() {
    return !!(this.process && this.process.exitCode === null && this.socket && !this.socket.destroyed);
  }

  pause() {
    // ponytail: true pause — mpv freezes in place, no kill, no rebuffer, exact position
    if (this.state !== 'PLAYING') return;
    this._mpvSend({ command: ['set_property', 'pause', true] });
    this.analyzer.stop();
    this.state = 'PAUSED';
    this.emit('stateChange', this.state);
  }

  resume() {
    if (this.state !== 'PAUSED' || !this.streamUrl) return;
    if (!this._alive()) {
      // dead process/IPC (e.g. expired URL) → respawn from last position
      this.isManualStop = false;
      this.state = 'PLAYING';
      this._spawnPlayer(this.currentTime);
      this.analyzer.start(this.streamUrl, this.currentTime);
      this.emit('stateChange', this.state);
      return;
    }
    this._mpvSend({ command: ['set_property', 'pause', false] });
    this.analyzer.start(this.streamUrl, this.currentTime);
    this.state = 'PLAYING';
    this.emit('stateChange', this.state);
  }

  togglePlayPause() {
    if (this.state === 'PLAYING') {
      this.pause();
    } else if (this.state === 'PAUSED') {
      this.resume();
    }
  }

  seek(secondsDelta) {
    // ponytail: relative seek via IPC — no restart; mpv clamps at the edges itself
    if (!this.streamUrl || !this._alive()) return;
    this._mpvSend({ command: ['seek', secondsDelta, 'relative'] });
    // optimistic: mpv time-pos events correct it shortly after
    const target = this.currentTime + secondsDelta;
    this.currentTime = this.duration > 0 ? Math.max(0, Math.min(this.duration, target)) : Math.max(0, target);
    // analysis follows (max 1x/sec so holding the key doesn't spam connections).
    // Skip restart saat mendarat <1.5 dtk dari akhir: ffmpeg tidak dapat data di
    // posisi EOF (restart-dead-loop), lagu langsung selesai dan _onEnded yang drop.
    const now = Date.now();
    const nearEnd = this.duration > 0 && target >= this.duration - 1.5;
    if ((!this._lastAnaStart || now - this._lastAnaStart > 1000) && !nearEnd) {
      this._lastAnaStart = now;
      this.analyzer.start(this.streamUrl, this.currentTime);
    }
    this.emit('timeupdate', this.currentTime);
  }

  refreshSpectrum() {
    // ponytail: restart stuck/desynced analysis — mpv untouched, song doesn't jump
    if (!this.streamUrl || this.state !== 'PLAYING') return;
    this.analyzer.start(this.streamUrl, this.currentTime);
  }

  setVolume(v) {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(v))));
    if (!Number.isFinite(clamped)) return this.volume;
    this.volume = clamped;
    this._mpvSend({ command: ['set_property', 'volume', this.volume] });
    this.emit('volumeChange', this.volume);
    return this.volume;
  }

  adjustVolume(delta) {
    return this.setVolume(this.volume + delta);
  }

  replay() {
    // ponytail: jump to second 0 via IPC — no restart, no buffering gap
    if (!this.streamUrl) return;
    this.currentTime = 0;
    if (!this._alive()) {
      this.isManualStop = false;
      this.state = 'PLAYING';
      this._spawnPlayer(0);
      this.analyzer.start(this.streamUrl);
      this.emit('stateChange', this.state);
      return;
    }
    this._mpvSend({ command: ['seek', 0, 'absolute'] });
    this._mpvSend({ command: ['set_property', 'pause', false] });
    this.analyzer.start(this.streamUrl); // analysis restarts from 0 too
    this.state = 'PLAYING';
    this.emit('stateChange', this.state);
  }

  stop(manual = true) {
    this._gen++;
    this.isManualStop = manual;
    this.analyzer.stop();
    if (this.socket) {
      try { this.socket.destroy();       } catch { /* ignore */ }
      this.socket = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.state = 'STOPPED';
    this.currentTime = 0;
    this.emit('stateChange', this.state);
  }
}
