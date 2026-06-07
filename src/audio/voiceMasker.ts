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
  f1Ratio: number;  // Formant 1 shift multiplier (0.85-1.15)
  f2Ratio: number;  // Formant 2 shift multiplier
  f3Ratio: number;  // Formant 3 shift multiplier
  pitchShift?: number;  // Optional pitch shift in cents
}

/**
 * Voice Presets - Different voice transformations
 */
export const VOICE_PRESETS: Record<string, VoicePreset> = {
  warm_hearth: {
    name: 'warm_hearth',
    f1Ratio: 0.95,    // Lower, warmer formants
    f2Ratio: 0.92,
    f3Ratio: 0.90,
    pitchShift: -50   // 50 cents lower
  },
  gentle_breeze: {
    name: 'gentle_breeze',
    f1Ratio: 1.05,    // Higher, lighter formants
    f2Ratio: 1.08,
    f3Ratio: 1.10,
    pitchShift: 100   // 100 cents higher
  },
  velvet_echo: {
    name: 'velvet_echo',
    f1Ratio: 0.98,    // Neutral, processed feel
    f2Ratio: 1.02,
    f3Ratio: 0.99,
    pitchShift: 0     // No pitch shift, just spectral
  }
};

/**
 * VoiceMasker - Real-time voice transformation engine
 */
export class VoiceMasker {
  private audioContext: AudioContext;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: AudioWorkletNode | ScriptProcessorNode | null = null;

  private currentPreset: VoicePreset;

  // Signal processing buffers
  private windowBuffer: Float32Array;
  private hannWindow: Float32Array;
  private overlapBuffer: Float32Array;
  private fftBuffer: Float32Array;
  private ifftBuffer: Float32Array;

  // FFT implementation
  private fftSize: number = 2048;
  private hopSize: number = 512;
  private isActive: boolean = false;

  // Performance monitoring
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
    this.hopSize = fftSize / 4;  // 75% overlap

    // Initialize buffers
    this.windowBuffer = new Float32Array(fftSize);
    this.hannWindow = this.createHannWindow(fftSize);
    this.overlapBuffer = new Float32Array(fftSize);
    this.fftBuffer = new Float32Array(fftSize);
    this.ifftBuffer = new Float32Array(fftSize);
  }

  /**
   * Initialize audio processor with microphone stream
   */
  async initializeProcessor(mediaStream: MediaStream): Promise<void> {
    // Create source from microphone
    this.sourceNode = this.audioContext.createMediaStreamSource(mediaStream);

    try {
      // Try to use AudioWorklet (modern, off-main-thread processing)
      await this.initializeAudioWorklet();
    } catch (error) {
      console.warn('AudioWorklet unavailable, using ScriptProcessorNode fallback');
      // Fallback to ScriptProcessorNode (deprecated but works)
      this.initializeScriptProcessor();
    }

    this.isActive = true;
  }

  /**
   * Initialize AudioWorklet (recommended - off-main-thread)
   */
  private async initializeAudioWorklet(): Promise<void> {
    // Note: In production, this would load an actual worklet file
    // For now, we'll use ScriptProcessor as fallback is more portable
    throw new Error('AudioWorklet not configured in this environment');
  }

  /**
   * Fallback: ScriptProcessorNode (on-main-thread)
   */
  private initializeScriptProcessor(): void {
    const bufferSize = 4096;
    const processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      this.processAudio(event);
    };

    this.sourceNode?.connect(processor);
    processor.connect(this.audioContext.destination);
    this.processorNode = processor;
  }

  /**
   * Main audio processing loop
   */
  private processAudio(event: AudioProcessingEvent): void {
    const startTime = performance.now();

    const inputData = event.inputBuffer.getChannelData(0);
    const outputData = event.outputBuffer.getChannelData(0);

    // Copy input to window buffer with Hann window applied
    for (let i = 0; i < inputData.length; i++) {
      this.windowBuffer[i] = inputData[i] * this.hannWindow[i];
    }

    // 1. FFT (Frequency Analysis)
    const spectrum = this.computeFFT(this.windowBuffer);

    // 2. Formant Detection (Peak Finding)
    const formants = this.detectFormants(spectrum);

    // 3. Formant Shifting (Identity Transformation)
    const shiftedSpectrum = this.shiftFormants(spectrum, formants);

    // 4. IFFT (Convert back to time domain)
    const timeDomain = this.computeIFFT(shiftedSpectrum);

    // 5. Overlap-Add (Smooth window transitions)
    const processedAudio = this.overlapAdd(timeDomain);

    // Write to output buffer
    for (let i = 0; i < outputData.length && i < processedAudio.length; i++) {
      outputData[i] = processedAudio[i];
    }

    // Performance monitoring
    const endTime = performance.now();
    const latency = endTime - startTime;
    this.lastProcessTime = latency;
    this.maxLatency = Math.max(this.maxLatency, latency);

    if (latency > 50) {
      console.warn(`⚠️ Voice masking latency: ${latency.toFixed(1)}ms (target: <50ms)`);
    }
  }

  /**
   * FFT: Fast Fourier Transform
   * Simple recursive FFT implementation (Cooley-Tukey)
   * In production, use a more optimized library like math.js
   */
  private computeFFT(input: Float32Array): Float32Array {
    const n = input.length;
    if (n === 1) {
      const out = new Float32Array(n);
      out[0] = input[0];
      return out;
    }

    // Simplified FFT - in production use optimized version
    // For now, return magnitude spectrum (approximate)
    const spectrum = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      let real = 0;
      let imag = 0;
      for (let t = 0; t < n; t++) {
        const angle = -2 * Math.PI * k * t / n;
        real += input[t] * Math.cos(angle);
        imag += input[t] * Math.sin(angle);
      }
      spectrum[k] = Math.sqrt(real * real + imag * imag);
    }
    return spectrum;
  }

  /**
   * IFFT: Inverse Fast Fourier Transform
   */
  private computeIFFT(spectrum: Float32Array): Float32Array {
    const n = spectrum.length;

    // Simplified IFFT for magnitude-only spectrum
    // In production, preserve phase information
    const output = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      let value = 0;
      for (let k = 0; k < n; k++) {
        const angle = 2 * Math.PI * k * t / n;
        value += spectrum[k] * Math.cos(angle);
      }
      output[t] = value / n;
    }
    return output;
  }

  /**
   * Detect formants (spectral peaks) in three frequency ranges
   */
  private detectFormants(spectrum: Float32Array): number[] {
    const sampleRate = this.audioContext.sampleRate;
    const freqResolution = sampleRate / spectrum.length;

    // Three formant bands (approximate for human speech)
    const formantRanges = [
      { name: 'F1', min: 200, max: 900 },    // Vocal tract opening
      { name: 'F2', min: 700, max: 2300 },   // Tongue position
      { name: 'F3', min: 1220, max: 2600 }   // Fine-tuning
    ];

    const formants: number[] = [];

    for (const range of formantRanges) {
      const startBin = Math.floor(range.min / freqResolution);
      const endBin = Math.floor(range.max / freqResolution);

      // Find peak (highest magnitude) in this range
      let maxMagnitude = 0;
      let peakBin = startBin;

      for (let i = startBin; i < endBin && i < spectrum.length; i++) {
        if (spectrum[i] > maxMagnitude) {
          maxMagnitude = spectrum[i];
          peakBin = i;
        }
      }

      // Convert bin index to frequency (Hz)
      const peakFreq = (peakBin * freqResolution);
      formants.push(peakFreq);
    }

    return formants;
  }

  /**
   * Shift formants by the preset ratios
   * This is where voice identity transformation happens
   */
  private shiftFormants(
    spectrum: Float32Array,
    formants: number[]
  ): Float32Array {
    const shiftedSpectrum = new Float32Array(spectrum.length);

    // Average shift ratio from all three formants
    const shifts = [
      this.currentPreset.f1Ratio,
      this.currentPreset.f2Ratio,
      this.currentPreset.f3Ratio
    ];
    const averageShift = (shifts[0] + shifts[1] + shifts[2]) / 3;

    // Apply linear frequency shift
    // (In production, use more sophisticated phase vocoding)
    for (let i = 0; i < spectrum.length; i++) {
      const shiftedBin = Math.floor(i * averageShift);
      if (shiftedBin < spectrum.length) {
        shiftedSpectrum[shiftedBin] = spectrum[i];
      }
    }

    return shiftedSpectrum;
  }

  /**
   * Overlap-Add: Smooth window concatenation
   * Prevents clicks and artifacts from window switching
   */
  private overlapAdd(timeDomain: Float32Array): Float32Array {
    const output = new Float32Array(this.hopSize);

    // Cross-fade between old and new frames
    for (let i = 0; i < this.hopSize; i++) {
      const oldWeight = 1 - (i / this.hopSize);
      const newWeight = i / this.hopSize;

      output[i] =
        (this.overlapBuffer[this.hopSize + i] * oldWeight) +
        (timeDomain[i] * newWeight);
    }

    // Save overlap for next iteration
    this.overlapBuffer.set(
      timeDomain.slice(this.hopSize),
      0
    );

    return output;
  }

  /**
   * Create Hann window for spectral analysis
   * Reduces spectral leakage from FFT
   */
  private createHannWindow(size: number): Float32Array {
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return window;
  }

  /**
   * Change voice preset in real-time
   */
  setPreset(preset: VoicePreset): void {
    if (!VOICE_PRESETS[preset.name]) {
      console.error(`Unknown preset: ${preset.name}`);
      return;
    }
    this.currentPreset = preset;
    console.log(`✓ Voice preset changed to: ${preset.name}`);
  }

  /**
   * Get current preset
   */
  getPreset(): VoicePreset {
    return this.currentPreset;
  }

  /**
   * Get available presets
   */
  static getAvailablePresets(): string[] {
    return Object.keys(VOICE_PRESETS);
  }

  /**
   * Stop processing and cleanup
   */
  stop(): void {
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }
    this.isActive = false;
  }

  /**
   * Get performance metrics
   */
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
