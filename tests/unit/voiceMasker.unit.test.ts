/**
 * VOICE MASKER UNIT TESTS
 * Tests for formant shifting, window functions, and latency
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import VoiceMasker, { VOICE_PRESETS, VoicePreset } from '../../src/audio/voiceMasker';

describe('VoiceMasker - Voice Identity Transformation', () => {
  let masker: VoiceMasker;
  let audioContext: AudioContext;

  beforeEach(() => {
    // Mock AudioContext (or use real one if available)
    try {
      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch (e) {
      // Offline context for testing
      audioContext = new OfflineAudioContext(1, 44100, 44100);
    }

    masker = new VoiceMasker(audioContext, VOICE_PRESETS.warm_hearth);
  });

  afterEach(() => {
    masker.stop();
  });

  // ========================================================================
  // 1. VOICE PRESET TESTS
  // ========================================================================

  describe('Voice Presets', () => {
    test('should have three predefined presets', () => {
      const presets = VoiceMasker.getAvailablePresets();
      expect(presets).toContain('warm_hearth');
      expect(presets).toContain('gentle_breeze');
      expect(presets).toContain('velvet_echo');
      expect(presets.length).toBe(3);
    });

    test('should have valid formant ratios (0.85-1.15)', () => {
      Object.values(VOICE_PRESETS).forEach((preset) => {
        expect(preset.f1Ratio).toBeGreaterThanOrEqual(0.85);
        expect(preset.f1Ratio).toBeLessThanOrEqual(1.15);
        expect(preset.f2Ratio).toBeGreaterThanOrEqual(0.85);
        expect(preset.f2Ratio).toBeLessThanOrEqual(1.15);
        expect(preset.f3Ratio).toBeGreaterThanOrEqual(0.85);
        expect(preset.f3Ratio).toBeLessThanOrEqual(1.15);
      });
    });

    test('Warm Hearth preset should lower voice', () => {
      const preset = VOICE_PRESETS.warm_hearth;
      expect(preset.f1Ratio).toBeLessThan(1.0);  // Lower formants
      expect(preset.f2Ratio).toBeLessThan(1.0);
      expect(preset.f3Ratio).toBeLessThan(1.0);
      expect(preset.pitchShift).toBeLessThan(0);  // Lower pitch
    });

    test('Gentle Breeze preset should raise voice', () => {
      const preset = VOICE_PRESETS.gentle_breeze;
      expect(preset.f1Ratio).toBeGreaterThan(1.0);  // Higher formants
      expect(preset.f2Ratio).toBeGreaterThan(1.0);
      expect(preset.f3Ratio).toBeGreaterThan(1.0);
      expect(preset.pitchShift).toBeGreaterThan(0);  // Higher pitch
    });

    test('should switch presets in real-time', () => {
      masker.setPreset(VOICE_PRESETS.gentle_breeze);
      expect(masker.getPreset().name).toBe('gentle_breeze');

      masker.setPreset(VOICE_PRESETS.velvet_echo);
      expect(masker.getPreset().name).toBe('velvet_echo');
    });
  });

  // ========================================================================
  // 2. WINDOW FUNCTION TESTS
  // ========================================================================

  describe('Hann Window (Spectral Windowing)', () => {
    test('should create correct Hann window', () => {
      const window = masker['createHannWindow'](8);

      // First and last should be ~0
      expect(window[0]).toBeCloseTo(0, 1);
      expect(window[7]).toBeCloseTo(0, 1);

      // Middle should be ~1
      expect(window[3]).toBeCloseTo(1, 0);
      expect(window[4]).toBeCloseTo(1, 0);

      // Should be symmetric
      expect(window[1]).toBeCloseTo(window[6], 5);
      expect(window[2]).toBeCloseTo(window[5], 5);
    });

    test('Hann window should be smooth (no discontinuities)', () => {
      const window = masker['createHannWindow'](1024);

      for (let i = 1; i < window.length; i++) {
        const diff = Math.abs(window[i] - window[i - 1]);
        expect(diff).toBeLessThan(0.1);  // Smooth transition
      }
    });

    test('Hann window should have correct energy', () => {
      const window = masker['createHannWindow'](512);

      let energy = 0;
      for (let i = 0; i < window.length; i++) {
        energy += window[i] * window[i];
      }

      const normEnergy = energy / window.length;
      expect(normEnergy).toBeCloseTo(1/3, 2);  // Theoretical Hann energy
    });
  });

  // ========================================================================
  // 3. FFT TESTS
  // ========================================================================

  describe('FFT (Frequency Analysis)', () => {
    test('should produce magnitude spectrum', () => {
      // Create test signal: 1000 Hz sine wave
      const sampleRate = 44100;
      const duration = 0.1;  // 100ms
      const samples = Math.floor(sampleRate * duration);
      const signal = new Float32Array(samples);

      for (let i = 0; i < samples; i++) {
        const t = i / sampleRate;
        signal[i] = Math.sin(2 * Math.PI * 1000 * t);  // 1000 Hz
      }

      const spectrum = masker['computeFFT'](signal);

      // Spectrum should have magnitude values
      expect(spectrum.length).toBe(signal.length);
      expect(spectrum.some(x => x > 0)).toBe(true);
    });

    test('should have maximum at signal frequency', () => {
      // 2 kHz test signal
      const testFreq = 2000;
      const sampleRate = 44100;
      const samples = 512;
      const signal = new Float32Array(samples);

      for (let i = 0; i < samples; i++) {
        signal[i] = Math.sin(2 * Math.PI * testFreq * i / sampleRate);
      }

      const spectrum = masker['computeFFT'](signal);

      // Find peak bin
      let maxVal = 0;
      let maxBin = 0;
      for (let i = 0; i < spectrum.length; i++) {
        if (spectrum[i] > maxVal) {
          maxVal = spectrum[i];
          maxBin = i;
        }
      }

      // Peak should be near expected frequency bin
      const expectedBin = Math.round((testFreq / sampleRate) * samples);
      expect(Math.abs(maxBin - expectedBin)).toBeLessThan(2);
    });
  });

  // ========================================================================
  // 4. FORMANT DETECTION TESTS
  // ========================================================================

  describe('Formant Detection (Spectral Peaks)', () => {
    test('should detect three formants', () => {
      const mockSpectrum = new Float32Array(1024);

      // Add peaks at formant frequencies
      // F1 ≈ 700 Hz, F2 ≈ 1220 Hz, F3 ≈ 2600 Hz
      mockSpectrum[70] = 10;    // F1 peak
      mockSpectrum[122] = 15;   // F2 peak
      mockSpectrum[260] = 12;   // F3 peak

      const formants = masker['detectFormants'](mockSpectrum);

      expect(formants.length).toBe(3);
      expect(formants[0]).toBeGreaterThan(0);  // F1
      expect(formants[1]).toBeGreaterThan(formants[0]);  // F2 > F1
      expect(formants[2]).toBeGreaterThan(formants[1]);  // F3 > F2
    });
  });

  // ========================================================================
  // 5. FORMANT SHIFTING TESTS
  // ========================================================================

  describe('Formant Shifting (Identity Transformation)', () => {
    test('should shift all frequencies uniformly', () => {
      const spectrum = new Float32Array(1024);

      // Create a simple spectrum
      for (let i = 0; i < 512; i++) {
        spectrum[i] = Math.sin(i / 100);  // Smooth spectrum
      }

      const mockFormants = [700, 1220, 2600];
      const shiftedSpectrum = masker['shiftFormants'](
        spectrum,
        mockFormants
      );

      // Shifted spectrum should have same length
      expect(shiftedSpectrum.length).toBe(spectrum.length);

      // Should have non-zero values
      const hasEnergy = shiftedSpectrum.some(x => x !== 0);
      expect(hasEnergy).toBe(true);
    });

    test('should preserve spectral energy during shift', () => {
      const spectrum = new Float32Array(512);
      for (let i = 0; i < spectrum.length; i++) {
        spectrum[i] = Math.random() * 0.5;
      }

      const mockFormants = [700, 1220, 2600];
      const shiftedSpectrum = masker['shiftFormants'](
        spectrum,
        mockFormants
      );

      // Calculate energy before and after
      let energyBefore = 0, energyAfter = 0;
      for (let i = 0; i < spectrum.length; i++) {
        energyBefore += spectrum[i] * spectrum[i];
        energyAfter += shiftedSpectrum[i] * shiftedSpectrum[i];
      }

      // Energy should be preserved (within tolerance)
      expect(energyAfter / energyBefore).toBeCloseTo(1, 1);
    });

    test('Warm Hearth should lower spectral content', () => {
      const spectrum = new Float32Array(1024);

      // Peak at bin 100 (higher frequency)
      spectrum[100] = 10;

      const formants = [700, 1220, 2600];
      const shiftedSpectrum = masker['shiftFormants'](
        spectrum,
        formants
      );

      // After 0.95x shift, peak should move lower (to lower bin)
      let maxBinShifted = 0;
      for (let i = 0; i < shiftedSpectrum.length; i++) {
        if (shiftedSpectrum[i] > shiftedSpectrum[maxBinShifted]) {
          maxBinShifted = i;
        }
      }

      expect(maxBinShifted).toBeLessThan(100);  // Moved to lower frequency
    });
  });

  // ========================================================================
  // 6. LATENCY & PERFORMANCE TESTS
  // ========================================================================

  describe('Performance & Latency', () => {
    test('should report metrics', () => {
      const metrics = masker.getMetrics();

      expect(metrics).toHaveProperty('lastLatency');
      expect(metrics).toHaveProperty('maxLatency');
      expect(metrics).toHaveProperty('isWithinTarget');
      expect(metrics).toHaveProperty('sampleRate');
      expect(metrics).toHaveProperty('fftSize');
      expect(metrics).toHaveProperty('currentPreset');
    });

    test('should have FFT size of 2048 by default', () => {
      const metrics = masker.getMetrics();
      expect(metrics.fftSize).toBe(2048);
    });

    test('should maintain correct sample rate', () => {
      const metrics = masker.getMetrics();
      expect(metrics.sampleRate).toBe(audioContext.sampleRate);
    });
  });

  // ========================================================================
  // 7. AUDIO CONTEXT LIFECYCLE TESTS
  // ========================================================================

  describe('Lifecycle Management', () => {
    test('should initialize without media stream', () => {
      // VoiceMasker should be created without immediate stream
      expect(masker).toBeDefined();
      expect(masker.getPreset()).toBeDefined();
    });

    test('should stop processing', () => {
      masker.stop();

      // After stop, metrics should still work
      const metrics = masker.getMetrics();
      expect(metrics).toBeDefined();
    });

    test('should reset state on creation', () => {
      const newMasker = new VoiceMasker(audioContext);
      const metrics = newMasker.getMetrics();

      expect(metrics.lastLatency).toBe('0.00');
      expect(metrics.maxLatency).toBe('0.00');

      newMasker.stop();
    });
  });

  // ========================================================================
  // 8. ERROR HANDLING TESTS
  // ========================================================================

  describe('Error Handling', () => {
    test('should handle invalid preset gracefully', () => {
      const invalidPreset = {
        name: 'invalid_preset' as any,
        f1Ratio: 0.9,
        f2Ratio: 0.9,
        f3Ratio: 0.9
      };

      // Should not throw, just log error
      expect(() => {
        masker.setPreset(invalidPreset);
      }).not.toThrow();
    });

    test('should handle multiple start/stop cycles', () => {
      for (let i = 0; i < 3; i++) {
        expect(() => masker.stop()).not.toThrow();
      }
    });
  });
});

// ============================================================================
// INTEGRATION SUITE MARKER
// ============================================================================
// Additional integration tests for real audio processing in:
// tests/integration/voicePresets.integration.test.ts
