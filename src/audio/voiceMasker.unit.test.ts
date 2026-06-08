import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VoiceMasker, VOICE_PRESETS, VoicePreset } from './voiceMasker';

// ─── helpers ────────────────────────────────────────────────────────────────

function mockAudioContext(sampleRate = 44100): AudioContext {
  return {
    sampleRate,
    createMediaStreamSource: vi.fn().mockReturnValue({
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createScriptProcessor: vi.fn().mockReturnValue({
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    }),
    destination: {},
  } as unknown as AudioContext;
}

function mockAudioProcessingEvent(
  inputSamples: Float32Array,
  outputSize: number
): AudioProcessingEvent {
  const outputData = new Float32Array(outputSize);
  return {
    inputBuffer: { getChannelData: () => inputSamples },
    outputBuffer: { getChannelData: () => outputData },
  } as unknown as AudioProcessingEvent;
}

function computeRMS(buffer: Float32Array, length = buffer.length): number {
  let sum = 0;
  for (let i = 0; i < length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / length);
}

function sineSignal(fftSize: number, bin: number): Float32Array {
  const sig = new Float32Array(fftSize);
  for (let n = 0; n < fftSize; n++) {
    sig[n] = Math.cos((2 * Math.PI * bin * n) / fftSize);
  }
  return sig;
}

// ─── test suites ─────────────────────────────────────────────────────────────

describe('createHannWindow', () => {
  it('returns a window of the requested size', () => {
    const m = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 256);
    const win = m.createHannWindow(64);
    expect(win.length).toBe(64);
  });

  it('starts and ends near zero', () => {
    const m = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 256);
    const win = m.createHannWindow(512);
    expect(win[0]).toBeCloseTo(0, 5);
    expect(win[511]).toBeCloseTo(0, 2);
  });

  it('peaks at the midpoint', () => {
    const m = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 256);
    const size = 64;
    const win = m.createHannWindow(size);
    const peak = Math.max(...win);
    expect(win[Math.floor(size / 2)]).toBeCloseTo(peak, 3);
  });

  it('is symmetric', () => {
    const m = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 256);
    const win = m.createHannWindow(64);
    for (let i = 0; i < 32; i++) {
      expect(win[i]).toBeCloseTo(win[63 - i], 5);
    }
  });

  it('all values are in [0, 1]', () => {
    const m = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 256);
    const win = m.createHannWindow(128);
    for (const v of win) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('computeFFTInPlace / computeIFFTInPlace', () => {
  let masker: VoiceMasker;
  const fftSize = 64;

  beforeEach(() => {
    masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, fftSize);
  });

  it('round-trips a signal through FFT → IFFT', () => {
    const original = sineSignal(fftSize, 5);
    const real = new Float32Array(original);
    const imag = new Float32Array(fftSize);

    masker.computeFFTInPlace(real, imag);
    masker.computeIFFTInPlace(real, imag);

    for (let i = 0; i < fftSize; i++) {
      expect(real[i]).toBeCloseTo(original[i], 4);
    }
  });

  it('all-zeros input produces all-zeros output', () => {
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);
    masker.computeFFTInPlace(real, imag);
    for (const v of real) expect(v).toBeCloseTo(0, 8);
    for (const v of imag) expect(v).toBeCloseTo(0, 8);
  });

  it('pure cosine at bin B produces magnitude N/2 at bin B', () => {
    const N = 16;
    const m = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, N);
    const BIN = 3;
    const real = sineSignal(N, BIN);
    const imag = new Float32Array(N);

    m.computeFFTInPlace(real, imag);

    const magAtBin = Math.sqrt(real[BIN] ** 2 + imag[BIN] ** 2);
    expect(magAtBin).toBeCloseTo(N / 2, 0);
  });

  it('energy at DC for constant signal equals N × amplitude', () => {
    const N = 32;
    const m = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, N);
    const real = new Float32Array(N).fill(1);
    const imag = new Float32Array(N);

    m.computeFFTInPlace(real, imag);

    expect(real[0]).toBeCloseTo(N, 3);
    expect(imag[0]).toBeCloseTo(0, 6);
  });

  it('IFFT is the inverse of FFT (linearity)', () => {
    const N = 32;
    const m = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, N);
    const a = new Float32Array(N).map(() => Math.random() - 0.5);
    const real = new Float32Array(a);
    const imag = new Float32Array(N);

    m.computeFFTInPlace(real, imag);
    m.computeIFFTInPlace(real, imag);

    for (let i = 0; i < N; i++) {
      expect(real[i]).toBeCloseTo(a[i], 4);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getFormantRatioForFreq', () => {
  let masker: VoiceMasker;

  beforeEach(() => {
    masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 256);
  });

  it('returns f1Ratio at and below F1 center (550 Hz)', () => {
    expect(masker.getFormantRatioForFreq(0)).toBeCloseTo(VOICE_PRESETS.warm_hearth.f1Ratio, 5);
    expect(masker.getFormantRatioForFreq(550)).toBeCloseTo(VOICE_PRESETS.warm_hearth.f1Ratio, 5);
  });

  it('returns f3Ratio at and above F3 center (1910 Hz)', () => {
    expect(masker.getFormantRatioForFreq(1910)).toBeCloseTo(VOICE_PRESETS.warm_hearth.f3Ratio, 5);
    expect(masker.getFormantRatioForFreq(4000)).toBeCloseTo(VOICE_PRESETS.warm_hearth.f3Ratio, 5);
  });

  it('interpolates linearly between F1 and F2 centers', () => {
    const midFreq = (550 + 1500) / 2; // 1025 Hz
    const expected = (VOICE_PRESETS.warm_hearth.f1Ratio + VOICE_PRESETS.warm_hearth.f2Ratio) / 2;
    expect(masker.getFormantRatioForFreq(midFreq)).toBeCloseTo(expected, 5);
  });

  it('interpolates linearly between F2 and F3 centers', () => {
    const midFreq = (1500 + 1910) / 2; // 1705 Hz
    const expected = (VOICE_PRESETS.warm_hearth.f2Ratio + VOICE_PRESETS.warm_hearth.f3Ratio) / 2;
    expect(masker.getFormantRatioForFreq(midFreq)).toBeCloseTo(expected, 5);
  });

  it('returns ratio = 1.0 for velvet_echo near F2 center', () => {
    const m = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.velvet_echo, 256);
    // f2Ratio = 1.02, f1Ratio = 0.98  → mid ≈ 1.0
    const mid = m.getFormantRatioForFreq(1025);
    expect(mid).toBeGreaterThan(0.98);
    expect(mid).toBeLessThan(1.02);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('computePitchRatio', () => {
  it('returns 1.0 when pitchShift and pitchRandomRange are both 0', () => {
    const preset: VoicePreset = {
      ...VOICE_PRESETS.velvet_echo,
      pitchShift: 0,
      pitchRandomRange: 0
    };
    const masker = new VoiceMasker(mockAudioContext(), preset, 256);
    for (let i = 0; i < 20; i++) {
      expect(masker.computePitchRatio()).toBeCloseTo(1.0, 8);
    }
  });

  it('returns correct ratio for a fixed pitchShift with no randomization', () => {
    const preset: VoicePreset = { ...VOICE_PRESETS.velvet_echo, pitchShift: 1200, pitchRandomRange: 0 };
    const masker = new VoiceMasker(mockAudioContext(), preset, 256);
    // 1200 cents = 1 octave → ratio 2.0
    expect(masker.computePitchRatio()).toBeCloseTo(2.0, 4);
  });

  it('returns ratio < 1 for negative pitchShift', () => {
    const preset: VoicePreset = { ...VOICE_PRESETS.velvet_echo, pitchShift: -1200, pitchRandomRange: 0 };
    const masker = new VoiceMasker(mockAudioContext(), preset, 256);
    expect(masker.computePitchRatio()).toBeCloseTo(0.5, 4);
  });

  it('produces varying ratios when pitchRandomRange > 0', () => {
    const preset: VoicePreset = { ...VOICE_PRESETS.velvet_echo, pitchShift: 0, pitchRandomRange: 50 };
    const masker = new VoiceMasker(mockAudioContext(), preset, 256);
    const ratios = Array.from({ length: 200 }, () => masker.computePitchRatio());
    const min = Math.min(...ratios);
    const max = Math.max(...ratios);
    expect(max - min).toBeGreaterThan(0);
  });

  it('all ratio values remain positive', () => {
    const masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.gentle_breeze, 256);
    for (let i = 0; i < 100; i++) {
      expect(masker.computePitchRatio()).toBeGreaterThan(0);
    }
  });

  it('smoothing prevents large single-frame jumps', () => {
    const preset: VoicePreset = { ...VOICE_PRESETS.velvet_echo, pitchShift: 0, pitchRandomRange: 1200 };
    const masker = new VoiceMasker(mockAudioContext(), preset, 256);
    let prev = masker.computePitchRatio();
    let maxDelta = 0;
    for (let i = 0; i < 500; i++) {
      const curr = masker.computePitchRatio();
      maxDelta = Math.max(maxDelta, Math.abs(curr - prev));
      prev = curr;
    }
    // Single-frame delta must be much less than the unsmoothed full-range jump (factor 4.0)
    expect(maxDelta).toBeLessThan(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAmplitude', () => {
  it('drives a loud signal toward targetRMS after convergence', () => {
    const preset: VoicePreset = { ...VOICE_PRESETS.warm_hearth, targetRMS: 0.15 };
    const masker = new VoiceMasker(mockAudioContext(), preset, 256);

    // Warm up the RMS envelope
    for (let i = 0; i < 200; i++) {
      const buf = new Float32Array(256).fill(0.8);
      masker.normalizeAmplitude(buf, 256);
    }

    const buf = new Float32Array(256).fill(0.8);
    masker.normalizeAmplitude(buf, 256);
    const rms = computeRMS(buf);
    expect(rms).toBeCloseTo(0.15, 1);
  });

  it('brings a quiet signal toward targetRMS after convergence', () => {
    const preset: VoicePreset = { ...VOICE_PRESETS.warm_hearth, targetRMS: 0.2 };
    const masker = new VoiceMasker(mockAudioContext(), preset, 256);

    for (let i = 0; i < 200; i++) {
      const buf = new Float32Array(256).fill(0.01);
      masker.normalizeAmplitude(buf, 256);
    }

    const buf = new Float32Array(256).fill(0.01);
    masker.normalizeAmplitude(buf, 256);
    const rms = computeRMS(buf);
    expect(rms).toBeGreaterThan(0.01);
  });

  it('does not divide by zero on silent input', () => {
    const masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 256);
    const buf = new Float32Array(256).fill(0);
    expect(() => masker.normalizeAmplitude(buf, 256)).not.toThrow();
    for (const v of buf) expect(isFinite(v)).toBe(true);
  });

  it('clamps output to ±1 (hard-clip safety)', () => {
    // Force gain to be very high by running with near-zero input first,
    // then feed a large signal
    const preset: VoicePreset = { ...VOICE_PRESETS.warm_hearth, targetRMS: 0.9 };
    const masker = new VoiceMasker(mockAudioContext(), preset, 256);

    // Prime with tiny RMS so gain becomes large
    for (let i = 0; i < 50; i++) {
      const buf = new Float32Array(256).fill(0.001);
      masker.normalizeAmplitude(buf, 256);
    }
    // Feed full-scale signal — without the clip it would overflow ±1
    const buf = new Float32Array(256).fill(0.99);
    masker.normalizeAmplitude(buf, 256);
    for (const v of buf) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('runningRMS envelope is slow to change (prevents gain pumping)', () => {
    const masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 256);
    const initialRunningRMS: number = (masker as any).runningRMS; // initialized to 0.15

    // One loud frame: with alpha=0.05, runningRMS moves only 5% toward 0.8
    const buf = new Float32Array(256).fill(0.8);
    masker.normalizeAmplitude(buf, 256);
    const afterOne: number = (masker as any).runningRMS;

    expect(afterOne).toBeGreaterThan(initialRunningRMS); // moved toward loud input
    expect(afterOne).toBeLessThan(0.4); // did NOT immediately jump to input level
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('shiftSpectrum', () => {
  let masker: VoiceMasker;
  const N = 64;

  beforeEach(() => {
    masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, N);
  });

  it('with ratio 1.0 and unity formant ratios preserves the spectrum', () => {
    // Use a flat preset so totalRatio = formantRatio × pitchRatio = 1 × 1 = 1
    const flatPreset: VoicePreset = {
      name: 'velvet_echo', f1Ratio: 1, f2Ratio: 1, f3Ratio: 1,
      pitchShift: 0, pitchRandomRange: 0, targetRMS: 0.15
    };
    const flatMasker = new VoiceMasker(mockAudioContext(), flatPreset, N);

    const inReal = new Float32Array(N).map(() => Math.random() - 0.5);
    const inImag = new Float32Array(N).map(() => Math.random() - 0.5);
    const inRealCopy = new Float32Array(inReal);
    const inImagCopy = new Float32Array(inImag);
    const outReal = new Float32Array(N);
    const outImag = new Float32Array(N);

    flatMasker.shiftSpectrum(inReal, inImag, outReal, outImag, 1.0);

    // With unity ratios everywhere, srcBin === k exactly → no interpolation error
    for (let k = 0; k <= N >> 1; k++) {
      expect(outReal[k]).toBeCloseTo(inRealCopy[k], 4);
      expect(outImag[k]).toBeCloseTo(inImagCopy[k], 4);
    }
  });

  it('zero input produces zero output regardless of ratio', () => {
    const inReal = new Float32Array(N);
    const inImag = new Float32Array(N);
    const outReal = new Float32Array(N);
    const outImag = new Float32Array(N);

    masker.shiftSpectrum(inReal, inImag, outReal, outImag, 1.2);

    for (const v of outReal) expect(v).toBeCloseTo(0, 8);
    for (const v of outImag) expect(v).toBeCloseTo(0, 8);
  });

  it('enforces conjugate symmetry in output (real-signal property)', () => {
    const inReal = sineSignal(N, 4);
    const inImag = new Float32Array(N);
    const outReal = new Float32Array(N);
    const outImag = new Float32Array(N);

    masker.shiftSpectrum(inReal, inImag, outReal, outImag, 1.0);

    for (let k = 1; k < N >> 1; k++) {
      expect(outReal[N - k]).toBeCloseTo(outReal[k], 5);
      expect(outImag[N - k]).toBeCloseTo(-outImag[k], 5);
    }
  });

  it('shifting up (ratio > 1) moves spectral energy to higher frequencies', () => {
    // Signal at bin 4
    const inReal = sineSignal(N, 4);
    const inImag = new Float32Array(N);
    masker.computeFFTInPlace(inReal, inImag);

    const outReal = new Float32Array(N);
    const outImag = new Float32Array(N);

    // Override preset ratios to 1.0 to isolate pitch-only shift
    const flat: VoicePreset = { ...VOICE_PRESETS.velvet_echo, f1Ratio: 1, f2Ratio: 1, f3Ratio: 1, pitchRandomRange: 0 };
    masker.setPreset(flat);
    masker.shiftSpectrum(inReal, inImag, outReal, outImag, 1.5);

    // Output should have energy around bin 4 * 1.5 = 6
    const mag6 = Math.sqrt(outReal[6] ** 2 + outImag[6] ** 2);
    const mag4 = Math.sqrt(outReal[4] ** 2 + outImag[4] ** 2);
    expect(mag6).toBeGreaterThan(mag4);
  });

  it('produces finite values for extreme ratios', () => {
    const inReal = sineSignal(N, 3);
    const inImag = new Float32Array(N);
    masker.computeFFTInPlace(inReal, inImag);

    for (const ratio of [0.1, 0.5, 2.0, 5.0]) {
      const outReal = new Float32Array(N);
      const outImag = new Float32Array(N);
      masker.shiftSpectrum(inReal, inImag, outReal, outImag, ratio);
      for (const v of outReal) expect(isFinite(v)).toBe(true);
      for (const v of outImag) expect(isFinite(v)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('preset management', () => {
  it('getAvailablePresets returns all three built-in presets', () => {
    const presets = VoiceMasker.getAvailablePresets();
    expect(presets).toContain('warm_hearth');
    expect(presets).toContain('gentle_breeze');
    expect(presets).toContain('velvet_echo');
    expect(presets.length).toBe(3);
  });

  it('getPreset returns the initially configured preset', () => {
    const masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.gentle_breeze, 256);
    expect(masker.getPreset().name).toBe('gentle_breeze');
  });

  it('setPreset switches the active preset', () => {
    const masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 256);
    masker.setPreset(VOICE_PRESETS.velvet_echo);
    expect(masker.getPreset().name).toBe('velvet_echo');
  });

  it('setPreset rejects unknown preset names without crashing', () => {
    const masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 256);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const invalid = { ...VOICE_PRESETS.warm_hearth, name: 'unknown' as 'warm_hearth' };
    masker.setPreset(invalid);
    expect(consoleSpy).toHaveBeenCalled();
    expect(masker.getPreset().name).toBe('warm_hearth'); // unchanged
    consoleSpy.mockRestore();
  });

  it('getMetrics reflects the current preset name', () => {
    const masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.gentle_breeze, 256);
    expect(masker.getMetrics().currentPreset).toBe('gentle_breeze');
  });

  it('preset change takes effect immediately on next ratio computation', () => {
    const masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.velvet_echo, 256);
    const ratioBefore = masker.getFormantRatioForFreq(0); // f1Ratio of velvet_echo
    masker.setPreset(VOICE_PRESETS.gentle_breeze);
    const ratioAfter = masker.getFormantRatioForFreq(0); // f1Ratio of gentle_breeze
    expect(ratioBefore).not.toBeCloseTo(ratioAfter, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('detectFormants', () => {
  it('returns three formant frequencies', () => {
    const masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 256);
    const spectrum = new Float32Array(2048).fill(0);
    // Place peaks in each formant band
    spectrum[Math.floor(400 / (44100 / 2048))] = 1;
    spectrum[Math.floor(1200 / (44100 / 2048))] = 1;
    spectrum[Math.floor(2000 / (44100 / 2048))] = 1;
    const formants = masker.detectFormants(spectrum);
    expect(formants.length).toBe(3);
  });

  it('detects peak within the F1 band (200–900 Hz)', () => {
    const masker = new VoiceMasker(mockAudioContext(44100), VOICE_PRESETS.warm_hearth, 256);
    const N = 2048;
    const spectrum = new Float32Array(N);
    const peakBin = Math.floor(600 / (44100 / N)); // 600 Hz
    spectrum[peakBin] = 10;
    const [f1] = masker.detectFormants(spectrum);
    expect(f1).toBeGreaterThanOrEqual(200);
    expect(f1).toBeLessThanOrEqual(900);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('stop / cleanup', () => {
  it('disconnects source and processor nodes on stop', () => {
    const ctx = mockAudioContext();
    const masker = new VoiceMasker(ctx, VOICE_PRESETS.warm_hearth, 256);
    const fakeSource = { connect: vi.fn(), disconnect: vi.fn() };
    const fakeProcessor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
    (masker as any).sourceNode = fakeSource;
    (masker as any).processorNode = fakeProcessor;

    masker.stop();

    expect(fakeSource.disconnect).toHaveBeenCalled();
    expect(fakeProcessor.disconnect).toHaveBeenCalled();
    expect((masker as any).sourceNode).toBeNull();
    expect((masker as any).processorNode).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('latency / performance', () => {
  it('processAudio completes in under 50ms for a 4096-sample buffer', () => {
    const masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 2048);
    const input = new Float32Array(4096).map(() => (Math.random() - 0.5) * 0.1);
    const event = mockAudioProcessingEvent(input, 4096);

    const start = performance.now();
    (masker as any).processAudio(event);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
    expect(masker.getMetrics().isWithinTarget).toBe(true);
  });

  it('getMetrics returns numeric strings for latency fields', () => {
    const masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 256);
    const input = new Float32Array(4096).fill(0);
    (masker as any).processAudio(mockAudioProcessingEvent(input, 4096));
    const m = masker.getMetrics();
    expect(Number(m.lastLatency)).toBeGreaterThanOrEqual(0);
    expect(Number(m.maxLatency)).toBeGreaterThanOrEqual(0);
  });

  it('maxLatency accumulates correctly across multiple calls', () => {
    const masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 2048);
    const input = new Float32Array(4096).fill(0);
    for (let i = 0; i < 5; i++) {
      (masker as any).processAudio(mockAudioProcessingEvent(input, 4096));
    }
    const m = masker.getMetrics();
    expect(Number(m.maxLatency)).toBeGreaterThanOrEqual(Number(m.lastLatency));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('voice intelligibility invariants', () => {
  it('all presets have formant ratios within the intelligible range (0.80–1.20)', () => {
    for (const preset of Object.values(VOICE_PRESETS)) {
      expect(preset.f1Ratio).toBeGreaterThanOrEqual(0.80);
      expect(preset.f1Ratio).toBeLessThanOrEqual(1.20);
      expect(preset.f2Ratio).toBeGreaterThanOrEqual(0.80);
      expect(preset.f2Ratio).toBeLessThanOrEqual(1.20);
      expect(preset.f3Ratio).toBeGreaterThanOrEqual(0.80);
      expect(preset.f3Ratio).toBeLessThanOrEqual(1.20);
    }
  });

  it('all presets have pitch shifts within ±500 cents (< 1 octave)', () => {
    for (const preset of Object.values(VOICE_PRESETS)) {
      if (preset.pitchShift !== undefined) {
        expect(Math.abs(preset.pitchShift)).toBeLessThanOrEqual(500);
      }
    }
  });

  it('processed signal has non-zero energy when input has energy', () => {
    const masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.gentle_breeze, 2048);
    const input = new Float32Array(4096).map(() => Math.sin(440 * 2 * Math.PI * Math.random()));
    const output = new Float32Array(4096);
    const event = {
      inputBuffer: { getChannelData: () => input },
      outputBuffer: { getChannelData: () => output },
    } as unknown as AudioProcessingEvent;
    (masker as any).processAudio(event);

    // Call multiple times to flush overlap buffer
    for (let i = 0; i < 5; i++) {
      (masker as any).processAudio(event);
    }

    const outputRMS = computeRMS(output);
    expect(outputRMS).toBeGreaterThan(0);
  });

  it('output differs from input (transformation is active)', () => {
    const masker = new VoiceMasker(mockAudioContext(), VOICE_PRESETS.warm_hearth, 2048);
    const input = new Float32Array(4096).map((_, i) =>
      0.3 * Math.sin(2 * Math.PI * 200 * i / 44100)
    );
    const output = new Float32Array(4096);
    const event = {
      inputBuffer: { getChannelData: () => input },
      outputBuffer: { getChannelData: () => output },
    } as unknown as AudioProcessingEvent;
    for (let i = 0; i < 6; i++) {
      (masker as any).processAudio(event);
    }

    // At least some output samples should differ from input samples
    const diffRMS = computeRMS(
      new Float32Array(output.map((v, i) => v - input[i]))
    );
    expect(diffRMS).toBeGreaterThan(0);
  });
});
