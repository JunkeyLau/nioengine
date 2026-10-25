/* Engine Sound Lab — P0 AudioWorklet probe.
   A deliberately small engine-ish synth used to verify the real-time path.
   The production engine will use crank-angle event synthesis, not this toy. */

class EngineProbeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.sr = sampleRate;
    this.running = false;
    this.mode = "engine";
    this.channel = "both";

    this.targetGain = 0;
    this.gain = 0;
    this.rpm = 900;
    this.targetRpm = 900;
    this.load = 0.35;

    this.phase = 0;
    this.cycleAmp = 1;
    this.sinePhase = 0;
    this.clickAcc = 0;
    this.clickInterval = 0.5;
    this.clickSamples = 0;

    this.noiseState = 0x12345678;
    this.lp1 = 0;
    this.lp2 = 0;
    this.dcIn = 0;
    this.dcOut = 0;

    this.frames = 0;
    this.meterFrames = 0;
    this.rms = 0;
    this.peak = 0;

    this.stereoBuf = new Float32Array(64);
    this.stereoIdx = 0;

    this.port.onmessage = (event) => this.onMessage(event.data);
    this.port.postMessage({
      type: "ready",
      processor: "engine-probe",
      sampleRate: this.sr,
    });
  }

  onMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "start": {
        this.mode = typeof msg.mode === "string" ? msg.mode : "engine";
        this.channel =
          this.mode === "left" || this.mode === "right" ? this.mode : "both";
        this.running = true;
        this.targetGain = clamp(
          typeof msg.gain === "number" ? msg.gain : 0.8,
          0,
          1,
        );
        if (typeof msg.rpm === "number") {
          this.rpm = clamp(msg.rpm, 0, 9000);
          this.targetRpm = this.rpm;
        }
        this.phase = 0;
        this.sinePhase = 0;
        this.clickAcc = this.clickInterval - 0.04;
        this.clickSamples = 0;
        this.port.postMessage({ type: "started", mode: this.mode });
        break;
      }

      case "stop": {
        this.running = false;
        this.targetGain = 0;
        this.port.postMessage({ type: "stopped" });
        break;
      }

      case "rpm": {
        if (typeof msg.rpm === "number") {
          this.targetRpm = clamp(msg.rpm, 0, 9000);
        }
        break;
      }

      case "gain": {
        if (typeof msg.gain === "number") {
          this.targetGain = clamp(msg.gain, 0, 1);
        }
        break;
      }

      case "config": {
        if (typeof msg.load === "number") {
          this.load = clamp(msg.load, 0, 1);
        }
        break;
      }

      case "ping": {
        this.port.postMessage({
          type: "pong",
          currentFrame,
          currentTime,
          frames: this.frames,
        });
        break;
      }

      default:
        break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;

    const left = out[0];
    const right = out.length > 1 ? out[1] : null;
    const n = left.length;
    const sr = this.sr;

    const gainCoef = 1 - Math.exp(-1 / (0.03 * sr));
    const rpmCoef = 1 - Math.exp(-1 / (0.09 * sr));

    try {
      for (let i = 0; i < n; i++) {
        this.gain += (this.targetGain - this.gain) * gainCoef;
        this.rpm += (this.targetRpm - this.rpm) * rpmCoef;

        let sample = 0;
        if (this.running) {
          if (this.mode === "engine") {
            sample = this.engineSample();
          } else if (this.mode === "click") {
            sample = this.clickSample();
          } else {
            sample = this.sineSample();
          }
        }

        // Soft saturation keeps the probe from ever producing hard digital peaks.
        sample = Math.tanh(sample * 1.15) * this.gain;

        // DC blocker.
        const y = sample - this.dcIn + 0.995 * this.dcOut;
        this.dcIn = sample;
        this.dcOut = y;

        left[i] = this.channel === "right" ? 0 : y;

        if (right) {
          if (this.channel === "left") {
            right[i] = 0;
          } else if (this.channel === "right") {
            right[i] = y;
          } else {
            const delayed = this.stereoBuf[this.stereoIdx];
            this.stereoBuf[this.stereoIdx] = y;
            this.stereoIdx = (this.stereoIdx + 1) & 63;
            right[i] = y * 0.94 + delayed * 0.28;
          }
        }

        const abs = y < 0 ? -y : y;
        if (abs > this.peak) this.peak = abs;
        this.rms += y * y;
      }
    } catch (err) {
      this.port.postMessage({
        type: "error",
        error: String((err && err.message) || err),
      });
      return true;
    }

    this.frames += n;
    this.meterFrames += n;

    if (this.meterFrames >= sr * 0.1) {
      this.port.postMessage({
        type: "meter",
        rms: Math.sqrt(this.rms / this.meterFrames),
        peak: this.peak,
        rpm: this.rpm,
        mode: this.mode,
        running: this.running,
        frames: this.frames,
        currentFrame,
        currentTime,
        gain: this.gain,
      });
      this.meterFrames = 0;
      this.rms = 0;
      this.peak = 0;
    }

    return true;
  }

  engineSample() {
    const sr = this.sr;
    // Four-stroke, 4-cylinder: two firing events per crank revolution.
    const fireHz = Math.max(5, (this.rpm / 60) * 2);

    this.phase += fireHz / sr;
    if (this.phase >= 1) {
      this.phase -= 1;
      this.cycleAmp = 1 + (Math.random() - 0.5) * 0.09;
    }

    const base = 2 * Math.PI * this.phase;
    let s = 0;

    for (let k = 1; k <= 12; k++) {
      s += Math.sin(base * k + k * 0.23) / Math.pow(k, 1.15);
    }
    s *= 0.44;

    // A smooth, band-limited-ish combustion pulse at the start of each firing.
    const pulse =
      (1 - Math.exp(-this.phase * 55)) *
      Math.exp(-this.phase * 7.5) *
      this.cycleAmp;
    s += pulse * 0.95;

    // Deterministic white noise, low-passed into intake/exhaust texture.
    this.noiseState =
      (Math.imul(this.noiseState, 1664525) + 1013904223) >>> 0;
    const white = (this.noiseState / 4294967296) * 2 - 1;
    this.lp1 += (white - this.lp1) * 0.18;
    s +=
      this.lp1 *
      (0.06 + this.load * 0.12 + Math.min(this.rpm / 7000, 1) * 0.05);

    const cutoff = 350 + this.rpm * 0.85;
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
    this.lp2 += (s - this.lp2) * a;
    s = this.lp2;

    return s * (0.5 + this.load * 0.5);
  }

  sineSample() {
    this.sinePhase += (2 * Math.PI * 440) / this.sr;
    if (this.sinePhase > 2 * Math.PI) this.sinePhase -= 2 * Math.PI;
    return Math.sin(this.sinePhase) * 0.34;
  }

  clickSample() {
    this.clickAcc += 1 / this.sr;
    if (this.clickAcc >= this.clickInterval) {
      this.clickAcc -= this.clickInterval;
      this.clickSamples = Math.floor(this.sr * 0.014);
      this.port.postMessage({
        type: "click",
        currentTime,
        interval: this.clickInterval,
      });
    }

    if (this.clickSamples <= 0) return 0;

    this.clickSamples -= 1;
    const t = (this.clickSamples / this.sr);
    return Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-t * 160) * 0.9;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

registerProcessor("engine-probe", EngineProbeProcessor);
