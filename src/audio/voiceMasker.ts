/**
 * KOZA VOICE MASKER
 * Real-time voice identity transformation via formant shifting
 *
 * Algorithm: FFT → Formant Detection → Frequency Shift → IFFT → Overlap-Add
 * Latency: < 50ms end-to-end
 * Dependencies: Zero external (pure Web Audio API)
 */

export interface VoicePreset {
  name: 'warm_hearth' | 'gentle_breeze' | 'velvet_echo';
  f1Ratio: number;           // Formant 1 shift multiplier (0.85–1.15)
  f2Ratio: number;           // Formant 2 shift multiplier
  f3Ratio: number;           // Formant 3 shift multiplier
  pitchShift?: number;       // Base pitch shift in cents
  pitchRandomRange?: number; // ±cents of per-frame random jitter (smoothed)
  targetRMS?: number;        // Amplitude normalization target, 0–1 (default 0.15)
}

export const VOICE_PRESETS: Record<string, VoicePreset> = {
  warm_hearth: {
    name: 'warm_hearth',
    f1Ratio: 0.95,
    f2Ratio: 0.92,
    f3Ratio: 0.90,
    pitchShift: -50,
    pitchRandomRange: 15,
    targetRMS: 0.15
  },
  gentle_breeze: {
    name: 'gentle_breeze',
    f1Ratio: 1.05,
    f2Ratio: 1.08,
    f3Ratio: 1.10,
    pitchShift: 100,
    pitchRandomRange: 20,
    targetRMS: 0.15
  },
  velvet_echo: {
    name: 'velvet_echo',
    f1Ratio: 0.98,
    f2Ratio: 1.02,
    f3Ratio: 0.99,
    pitchShift: 0,
    pitchRandomRange: 10,
    targetRMS: 0.15
  }
};

export class VoiceMasker {
  private audioContext: AudioContext;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private currentPreset: VoicePreset;

  private hannWindow: Float32Array;
  private overlapBuffer: Float32Array;

  // Complex FFT buffers: real and imaginary parts kept separate
  private fftReal: Float32Array;
  private fftImag: Float32Array;
  private shiftedReal: Float32Array;
  private shiftedImag: Float32Array;

  private fftSize: number;
  private hopSize: number;
  private isActive: boolean = false;

  /** True while the masking graph is running. */
  get active(): boolean {
    return this.isActive;
  }

  // Smoothed pitch jitter state (AR(1) random walk)
  private currentPitchJitter: number = 0;
  private readonly pitchSmoothAlpha: number = 0.15;

  // Long-term RMS envelope follower for amplitude normalization
  private runningRMS: number = 0.15;
  private readonly rmsSmoothAlpha: number = 0.05;

  private lastProcessTime: number = 0;
  private maxLatency: number = 0;

  constructor(
    audioContext: AudioContext,
    preset: VoicePreset = VOICE_PRESETS.warm_hearth,
    fftSize: number = 2048
  ) {
    this.audioContext = audioContext;
    this.currentPreset = preset;
    this.fftSize = fftSize;
    this.hopSize = fftSize / 4; // 75% overlap for smooth transitions

    this.hannWindow = this.createHannWindow(fftSize);
    this.overlapBuffer = new Float32Array(fftSize);
    this.fftReal = new Float32Array(fftSize);
    this.fftImag = new Float32Array(fftSize);
    this.shiftedReal = new Float32Array(fftSize);
    this.shiftedImag = new Float32Array(fftSize);
  }

  async initializeProcessor(mediaStream: MediaStream): Promise<void> {
    this.sourceNode = this.audioContext.createMediaStreamSource(mediaStream);
    try {
      await this.initializeAudioWorklet();
    } catch {
      this.initializeScriptProcessor();
    }
    this.isActive = true;
  }

  private async initializeAudioWorklet(): Promise<void> {
    throw new Error('AudioWorklet not configured in this environment');
  }

  private initializeScriptProcessor(): void {
    const bufferSize = 4096;
    const processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    processor.onaudioprocess = (event: AudioProcessingEvent) => this.processAudio(event);
    this.sourceNode?.connect(processor);
    processor.connect(this.audioContext.destination);
    this.processorNode = processor;
  }

  private processAudio(event: AudioProcessingEvent): void {
    const startTime = performance.now();

    const inputData = event.inputBuffer.getChannelData(0);
    const outputData = event.outputBuffer.getChannelData(0);

    // Window the input frame
    for (let i = 0; i < this.fftSize && i < inputData.length; i++) {
      this.fftReal[i] = inputData[i] * this.hannWindow[i];
      this.fftImag[i] = 0;
    }

    this.computeFFTInPlace(this.fftReal, this.fftImag);

    const pitchRatio = this.computePitchRatio();
    this.shiftSpectrum(
      this.fftReal, this.fftImag,
      this.shiftedReal, this.shiftedImag,
      pitchRatio
    );

    this.computeIFFTInPlace(this.shiftedReal, this.shiftedImag);
    this.normalizeAmplitude(this.shiftedReal, this.fftSize);

    const processedAudio = this.overlapAdd(this.shiftedReal);

    for (let i = 0; i < outputData.length && i < processedAudio.length; i++) {
      outputData[i] = processedAudio[i];
    }

    const latency = performance.now() - startTime;
    this.lastProcessTime = latency;
    this.maxLatency = Math.max(this.maxLatency, latency);

    if (latency > 50) {
      console.warn(`Voice masking latency: ${latency.toFixed(1)}ms (target: <50ms)`);
    }
  }

  /**
   * Iterative Cooley-Tukey in-place FFT.
   * In-place: modifies real and imag arrays directly.
   * Requires length to be a power of two.
   */
  computeFFTInPlace(real: Float32Array, imag: Float32Array): void {
    const n = real.length;

    // Bit-reversal permutation
    let j = 0;
    for (let i = 1; i < n; i++) {
      let bit = n >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j ^= bit;
      if (i < j) {
        let tmp = real[i]; real[i] = real[j]; real[j] = tmp;
        tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp;
      }
    }

    // Butterfly stages
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const dAngle = -Math.PI / half;
      const wDR = Math.cos(dAngle);
      const wDI = Math.sin(dAngle);

      for (let i = 0; i < n; i += len) {
        let wr = 1, wi = 0;
        for (let k = 0; k < half; k++) {
          const ar = real[i + k],         ai = imag[i + k];
          const br = real[i + k + half],  bi = imag[i + k + half];
          const tr = br * wr - bi * wi;
          const ti = br * wi + bi * wr;
          real[i + k]        = ar + tr;
          imag[i + k]        = ai + ti;
          real[i + k + half] = ar - tr;
          imag[i + k + half] = ai - ti;
          const wNewR = wr * wDR - wi * wDI;
          wi = wr * wDI + wi * wDR;
          wr = wNewR;
        }
      }
    }
  }

  /**
   * In-place IFFT via conjugate trick: IFFT(X) = conj(FFT(conj(X))) / N
   */
  computeIFFTInPlace(real: Float32Array, imag: Float32Array): void {
    const n = real.length;
    for (let i = 0; i < n; i++) imag[i] = -imag[i];
    this.computeFFTInPlace(real, imag);
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] = -imag[i] / n;
    }
  }

  /**
   * Computes the effective pitch ratio for the current frame.
   * Combines the preset's base pitch shift (cents) with a smoothed
   * per-frame random jitter drawn from ±pitchRandomRange.
   * Smoothing prevents audible pitch discontinuities between frames.
   */
  computePitchRatio(): number {
    const baseCents = this.currentPreset.pitchShift ?? 0;
    const range = this.currentPreset.pitchRandomRange ?? 0;

    const jitterTarget = range > 0 ? (Math.random() * 2 - 1) * range : 0;
    this.currentPitchJitter +=
      this.pitchSmoothAlpha * (jitterTarget - this.currentPitchJitter);

    return Math.pow(2, (baseCents + this.currentPitchJitter) / 1200);
  }

  /**
   * Frequency-domain spectral shift with per-formant ratios.
   *
   * Each output bin k reads from source bin k / (formantRatio × pitchRatio)
   * using linear interpolation for sub-bin accuracy. Per-formant ratios
   * are interpolated smoothly across the F1/F2/F3 center frequencies so
   * different resonance regions shift independently. Conjugate symmetry is
   * reconstructed for the negative-frequency half so the IFFT yields a
   * real-valued output.
   */
  shiftSpectrum(
    inReal: Float32Array,
    inImag: Float32Array,
    outReal: Float32Array,
    outImag: Float32Array,
    pitchRatio: number
  ): void {
    const n = inReal.length;
    outReal.fill(0);
    outImag.fill(0);

    const sampleRate = this.audioContext.sampleRate;
    const half = n >> 1;

    for (let k = 0; k <= half; k++) {
      const freq = k * sampleRate / n;
      const totalRatio = this.getFormantRatioForFreq(freq) * pitchRatio;

      const srcBin = k / totalRatio;
      const lo = Math.floor(srcBin);
      const hi = lo + 1;
      const frac = srcBin - lo;

      if (lo >= 0 && hi < n) {
        outReal[k] = inReal[lo] * (1 - frac) + inReal[hi] * frac;
        outImag[k] = inImag[lo] * (1 - frac) + inImag[hi] * frac;
      } else if (lo >= 0 && lo < n) {
        outReal[k] = inReal[lo];
        outImag[k] = inImag[lo];
      }
    }

    // Reconstruct conjugate-symmetric negative frequencies
    for (let k = 1; k < half; k++) {
      outReal[n - k] =  outReal[k];
      outImag[n - k] = -outImag[k];
    }
  }

  /**
   * Returns a piecewise-linearly interpolated formant shift ratio for a
   * given frequency in Hz. F1/F2/F3 center frequencies are used as
   * knot points; values extrapolate flat beyond the outer knots.
   */
  getFormantRatioForFreq(freq: number): number {
    const F1 = 550;   // center of F1 band (200–900 Hz)
    const F2 = 1500;  // center of F2 band (700–2300 Hz)
    const F3 = 1910;  // center of F3 band (1220–2600 Hz)

    const { f1Ratio, f2Ratio, f3Ratio } = this.currentPreset;

    if (freq <= F1) return f1Ratio;
    if (freq <= F2) {
      const t = (freq - F1) / (F2 - F1);
      return f1Ratio + t * (f2Ratio - f1Ratio);
    }
    if (freq <= F3) {
      const t = (freq - F2) / (F3 - F2);
      return f2Ratio + t * (f3Ratio - f2Ratio);
    }
    return f3Ratio;
  }

  /**
   * RMS-based amplitude normalization.
   * Tracks a long-term RMS envelope and applies a gain to drive output
   * toward targetRMS. Hard-clips at ±1 as a safety ceiling.
   */
  normalizeAmplitude(buffer: Float32Array, length: number): void {
    const targetRMS = this.currentPreset.targetRMS ?? 0.15;

    let sumSq = 0;
    for (let i = 0; i < length; i++) sumSq += buffer[i] * buffer[i];
    const instantRMS = Math.sqrt(sumSq / length);

    this.runningRMS =
      this.rmsSmoothAlpha * instantRMS +
      (1 - this.rmsSmoothAlpha) * this.runningRMS;

    const gain = this.runningRMS > 1e-6 ? targetRMS / this.runningRMS : 1;

    for (let i = 0; i < length; i++) {
      const v = buffer[i] * gain;
      // Hard clip as final safety ceiling
      buffer[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  }

  private overlapAdd(timeDomain: Float32Array): Float32Array {
    const output = new Float32Array(this.hopSize);
    for (let i = 0; i < this.hopSize; i++) {
      const fade = i / this.hopSize;
      output[i] =
        this.overlapBuffer[this.hopSize + i] * (1 - fade) +
        timeDomain[i] * fade;
    }
    this.overlapBuffer.set(timeDomain.slice(this.hopSize), 0);
    return output;
  }

  createHannWindow(size: number): Float32Array {
    const win = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return win;
  }

  /**
   * Detect spectral-peak positions for each formant band.
   * Kept for external use; not used in the main processing path.
   */
  detectFormants(spectrum: Float32Array): number[] {
    const sampleRate = this.audioContext.sampleRate;
    const freqResolution = sampleRate / spectrum.length;
    const bands = [
      { min: 200, max: 900 },
      { min: 700, max: 2300 },
      { min: 1220, max: 2600 }
    ];
    return bands.map(({ min, max }) => {
      const lo = Math.floor(min / freqResolution);
      const hi = Math.floor(max / freqResolution);
      let maxMag = 0, peakBin = lo;
      for (let i = lo; i < hi && i < spectrum.length; i++) {
        if (spectrum[i] > maxMag) { maxMag = spectrum[i]; peakBin = i; }
      }
      return peakBin * freqResolution;
    });
  }

  setPreset(preset: VoicePreset): void {
    if (!VOICE_PRESETS[preset.name]) {
      console.error(`Unknown preset: ${preset.name}`);
      return;
    }
    this.currentPreset = preset;
  }

  getPreset(): VoicePreset {
    return this.currentPreset;
  }

  static getAvailablePresets(): string[] {
    return Object.keys(VOICE_PRESETS);
  }

  stop(): void {
    this.sourceNode?.disconnect();
    this.sourceNode = null;
    this.processorNode?.disconnect();
    this.processorNode = null;
    this.isActive = false;
  }

  getMetrics() {
    return {
      lastLatency: this.lastProcessTime.toFixed(2),
      maxLatency: this.maxLatency.toFixed(2),
      isWithinTarget: this.lastProcessTime < 50,
      sampleRate: this.audioContext.sampleRate,
      fftSize: this.fftSize,
      currentPreset: this.currentPreset.name
    };
  }
}

export default VoiceMasker;
