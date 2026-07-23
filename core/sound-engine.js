/**
 * Sound & haptics — DOM-only (Web Audio + a CSS class toggle), no Node/
 * Electron APIs. Every sound is synthesized (oscillators/noise buffers),
 * never a shipped audio file: keeps this dependency-free, CSP-safe (no
 * network fetch, no file:// load into claude.ai's page) and license-clean.
 *
 * "Haptics" is honestly a visual micro-pulse substitute — desktop hardware
 * has no rumble motor, so `pulse()` toggles a brief CSS class instead of
 * pretending to vibrate anything.
 */

class SoundEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.settings = null;
    this.ambientNodes = null; // { stop(), gainNode }
    this.ambientTrack = "off";
  }

  _ensureContext() {
    if (this.ctx) return this.ctx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    this.ctx = new AudioCtx();
    this.masterGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    return this.ctx;
  }

  applySettings(settings) {
    this.settings = settings;
    const s = settings.sound || {};
    if (this.masterGain) {
      this.masterGain.gain.value = s.muted ? 0 : (s.volume != null ? s.volume : 0.6);
    }
    const wantTrack = s.muted ? "off" : ((s.ambient && s.ambient.track) || "off");
    if (wantTrack !== this.ambientTrack) {
      this.stopAmbient();
      if (wantTrack !== "off") this.startAmbient(wantTrack, (s.ambient && s.ambient.volume) || 0.3);
    } else if (this.ambientNodes && s.ambient) {
      this._setAmbientVolume(s.ambient.volume);
    }
  }

  /** type: "click" | "hover" | "notification" | "achievement" */
  play(type) {
    const s = this.settings && this.settings.sound;
    if (!s || s.muted || !s.pack || s.pack === "off") return;
    if (s.perType && s.perType[type] === false) return;
    const ctx = this._ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();

    const vol = (s.volume != null ? s.volume : 0.6) * 0.5;
    const presets = {
      "8bit": {
        click: { freq: 440, type: "square", duration: 0.05 },
        hover: { freq: 660, type: "square", duration: 0.03 },
        notification: { freq: 523, type: "square", duration: 0.12 },
        achievement: { freq: 784, type: "square", duration: 0.18 },
      },
      minimal: {
        click: { freq: 800, type: "sine", duration: 0.04 },
        hover: { freq: 900, type: "sine", duration: 0.02 },
        notification: { freq: 660, type: "sine", duration: 0.1 },
        achievement: { freq: 880, type: "sine", duration: 0.15 },
      },
      soft: {
        click: { freq: 300, type: "sine", duration: 0.09, filterFreq: 800 },
        hover: { freq: 350, type: "sine", duration: 0.06, filterFreq: 700 },
        notification: { freq: 400, type: "sine", duration: 0.2, filterFreq: 900 },
        achievement: { freq: 500, type: "sine", duration: 0.3, filterFreq: 1200 },
      },
    };
    const preset = (presets[s.pack] && presets[s.pack][type]) || presets.minimal[type] || presets.minimal.click;
    this._tone(ctx, { ...preset, volume: vol });
  }

  _tone(ctx, { freq, type = "sine", duration = 0.08, volume = 0.3, filterFreq = null }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);

    let tail = osc;
    if (filterFreq) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = filterFreq;
      tail.connect(filter);
      tail = filter;
    }
    tail.connect(gain);
    gain.connect(this.masterGain || ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.03);
  }

  _createNoiseBuffer(ctx, seconds = 4) {
    const bufferSize = Math.floor(seconds * ctx.sampleRate);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** track: "rain" | "cafe" | "lofi" — all procedurally generated, no assets. */
  startAmbient(track, volume = 0.3) {
    const ctx = this._ensureContext();
    if (!ctx || track === "off") return;
    if (ctx.state === "suspended") ctx.resume();
    this.stopAmbient();

    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = this._createNoiseBuffer(ctx);
    noiseSrc.loop = true;

    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    gain.gain.value = volume;

    // A slow LFO modulates gain so noise reads as "rain"/"murmur" rather
    // than a flat hiss.
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();

    if (track === "rain") {
      filter.type = "bandpass";
      filter.frequency.value = 3200;
      filter.Q.value = 0.6;
      lfo.frequency.value = 0.15;
      lfoGain.gain.value = volume * 0.35;
    } else if (track === "cafe") {
      filter.type = "lowpass";
      filter.frequency.value = 900;
      lfo.frequency.value = 0.08;
      lfoGain.gain.value = volume * 0.2;
    } else {
      filter.type = "lowpass";
      filter.frequency.value = 1400;
      lfo.frequency.value = 0.05;
      lfoGain.gain.value = volume * 0.15;
    }

    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);
    noiseSrc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain || ctx.destination);

    const extraOscs = [];
    if (track === "lofi") {
      // A soft, slightly-detuned two-note pad under the noise texture.
      [220, 277.18].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        osc.detune.value = i === 0 ? -6 : 6;
        const oGain = ctx.createGain();
        oGain.gain.value = volume * 0.25;
        osc.connect(oGain);
        oGain.connect(this.masterGain || ctx.destination);
        osc.start();
        extraOscs.push(osc);
      });
    }

    noiseSrc.start();
    lfo.start();

    this.ambientNodes = {
      stop: () => {
        try { noiseSrc.stop(); } catch (_e) { /* already stopped */ }
        try { lfo.stop(); } catch (_e) { /* already stopped */ }
        extraOscs.forEach((o) => { try { o.stop(); } catch (_e) { /* already stopped */ } });
      },
      gainNode: gain,
    };
    this.ambientTrack = track;
  }

  _setAmbientVolume(volume) {
    if (this.ambientNodes && this.ambientNodes.gainNode) {
      this.ambientNodes.gainNode.gain.value = volume != null ? volume : 0.3;
    }
  }

  stopAmbient() {
    if (this.ambientNodes) {
      this.ambientNodes.stop();
      this.ambientNodes = null;
    }
    this.ambientTrack = "off";
  }

  // 0..1 live amplitude — the only real "audio present" signal this app
  // has, used to pulse a dock button ring rather than faking reactivity to
  // audio that was never actually playing.
  getAmplitude() {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return sum / data.length / 255;
  }

  pulse(el, intensity = 0.5) {
    if (!el) return;
    const s = this.settings && this.settings.sound;
    const haptics = s && s.hapticsIntensity != null ? s.hapticsIntensity : 0.5;
    const strength = Math.max(0, Math.min(1, intensity * haptics));
    if (strength <= 0) return;
    el.style.setProperty("--bc-haptic-strength", strength.toFixed(2));
    el.classList.add("bc-haptic-pulse");
    setTimeout(() => el.classList.remove("bc-haptic-pulse"), 220);
  }
}

module.exports = { SoundEngine };
