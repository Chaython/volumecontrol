/**
 * Experimental block-continuous, stereo-linked true-peak lookahead limiter.
 *
 * This is a pure DSP research core, NOT wired into Volume Control playback.
 * AudioWorklet routing, CSP compatibility, sample-rate changes and measured
 * output compliance must be verified separately before runtime enablement.
 *
 * Inputs are already volume-adjusted PCM. Output keeps the same channel count.
 * Uses 4x windowed-sinc reconstruction (24 taps, three fractional phases),
 * 5 ms of lookahead and an immediate reduction / held, slow release envelope.
 * Linked channel gain retains stereo balance. No AudioContext is created here.
 */

const PHASE_COUNT = 4;
const TAP_RADIUS = 12;
const TAPS = TAP_RADIUS * 2;

function sinc(value) {
    if (Math.abs(value) < 1e-12) return 1;
    return Math.sin(Math.PI * value) / (Math.PI * value);
}

const coefficients = [1, 2, 3].map(phase => {
    const fraction = phase / PHASE_COUNT;
    const weights = new Float64Array(TAPS);
    let sum = 0;
    for (let tap = 0; tap < TAPS; tap++) {
        const distance = fraction - (tap - TAP_RADIUS + 1);
        const window = Math.abs(distance) >= TAP_RADIUS ? 0 :
            0.42 + 0.5 * Math.cos(Math.PI * distance / TAP_RADIUS) +
            0.08 * Math.cos(2 * Math.PI * distance / TAP_RADIUS);
        const weight = sinc(distance) * window;
        weights[tap] = weight;
        sum += weight;
    }
    for (let tap = 0; tap < TAPS; tap++) weights[tap] /= sum;
    return weights;
});

function dbToGain(db) {
    return Math.pow(10, db / 20);
}

export class LookaheadTruePeakLimiter {
    constructor({ sampleRate = 48000, ceilingDb = -1, safetyMarginDb = 0.75,
        lookaheadMs = 5, releaseMs = 250, channels = 2 } = {}) {
        if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000)
            throw new RangeError('sampleRate must be in 8000..384000 Hz');
        if (!Number.isFinite(ceilingDb) || ceilingDb > -0.1 || ceilingDb < -12)
            throw new RangeError('ceilingDb must be in -12..-0.1 dBFS');
        if (!Number.isFinite(safetyMarginDb) || safetyMarginDb < 0 || safetyMarginDb > 3)
            throw new RangeError('safetyMarginDb must be 0..3 dB');
        if (!Number.isFinite(lookaheadMs) || lookaheadMs < 2 || lookaheadMs > 20)
            throw new RangeError('lookaheadMs must be 2..20 ms');
        if (!Number.isFinite(releaseMs) || releaseMs < 50 || releaseMs > 2000)
            throw new RangeError('releaseMs must be 50..2000 ms');
        if (!Number.isInteger(channels) || channels < 1 || channels > 8)
            throw new RangeError('channels must be 1..8');
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.ceilingDb = ceilingDb;
        this.limit = dbToGain(ceilingDb - safetyMarginDb);
        this.delaySamples = Math.max(TAPS + 2, Math.ceil(sampleRate * lookaheadMs / 1000));
        this.latencySeconds = this.delaySamples / sampleRate;
        this.bufferLength = this.delaySamples + TAPS + 2;
        this.buffers = Array.from({ length: channels }, () =>
            new Float64Array(this.bufferLength));
        this.releaseAlpha = 1 - Math.exp(-1 / (sampleRate * releaseMs / 1000));
        this.gain = 1;
        this.holdSamples = 0;
        this.position = 0;
        this.maximumDetectedPeak = 0;
        this.maximumInputSample = 0;
    }

    reset() {
        for (const buffer of this.buffers) buffer.fill(0);
        this.gain = 1;
        this.holdSamples = 0;
        this.position = 0;
        this.maximumDetectedPeak = 0;
        this.maximumInputSample = 0;
    }

    /**
     * Process a contiguous block of 1..8 channels, each Float32Array.
     * Frame count and array identity can vary between calls. process() is
     * convenient for offline tests; processInto() avoids PCM allocations
     * for realtime processing. Call reset() on discontinuities.
     */
    process(input) {
        if (!Array.isArray(input) || input.length !== this.channels ||
            !input.every(data => data instanceof Float32Array || data instanceof Float64Array)) {
            throw new TypeError('Expected configured number of typed PCM channels');
        }
        const output = Array.from({ length: this.channels }, () => new Float32Array(input[0].length));
        return this.processInto(input, output);
    }

    // Intended future AudioWorklet entrypoint: write into browser-supplied
    // PCM buffers without allocating new arrays on the realtime audio thread.
    processInto(input, output) {
        if (!Array.isArray(input) || input.length !== this.channels ||
            !input.every(data => data instanceof Float32Array || data instanceof Float64Array)) {
            throw new TypeError('Expected configured number of typed PCM channels');
        }
        const frames = input[0].length;
        if (frames < 1 || input.some(data => data.length !== frames)) {
            throw new RangeError('Channels need equal, non-zero lengths');
        }
        if (!Array.isArray(output) || output.length !== this.channels ||
            !output.every(data => (data instanceof Float32Array || data instanceof Float64Array) &&
                data.length === frames) ||
            output.some(data => input.includes(data))) {
            throw new TypeError('Provide separate output PCM buffers matching all input channels');
        }
        for (let frame = 0; frame < frames; frame++) {
            const time = this.position;
            const writeIndex = time % this.bufferLength;
            let peak = 0;
            for (let ch = 0; ch < this.channels; ch++) {
                const sample = input[ch][frame];
                if (!Number.isFinite(sample)) {
                    this.reset();
                    throw new RangeError('Non-finite PCM input; limiter state reset');
                }
                this.buffers[ch][writeIndex] = sample;
                const magnitude = Math.abs(sample);
                peak = Math.max(peak, magnitude);
                this.maximumInputSample = Math.max(this.maximumInputSample, magnitude);
            }
            // Estimate the reconstructed maximum between samples t-12 and
            // t-11. The entire symmetric window is available by time t,
            // well before the corresponding delayed samples reach output.
            if (time >= TAPS - 1) {
                const base = time - TAPS + 1;
                for (let ch = 0; ch < this.channels; ch++) {
                    const buffer = this.buffers[ch];
                    for (const taps of coefficients) {
                        let reconstructed = 0;
                        for (let i = 0; i < TAPS; i++) {
                            reconstructed += taps[i] * buffer[(base + i) % this.bufferLength];
                        }
                        peak = Math.max(peak, Math.abs(reconstructed));
                    }
                }
            }
            this.maximumDetectedPeak = Math.max(this.maximumDetectedPeak, peak);
            const demand = peak > this.limit ? this.limit / peak : 1;
            if (demand < this.gain) {
                this.gain = demand;  // immediate attack within the lookahead delay
            }
            if (demand < 1) {
                // Keep attenuation until the detected transient has passed
                // the delayed output; don't let the envelope bounce on drums.
                this.holdSamples = this.delaySamples + TAPS;
            } else if (this.holdSamples > 0) {
                this.holdSamples--;
            } else {
                this.gain += (1 - this.gain) * this.releaseAlpha;
            }

            if (time >= this.delaySamples) {
                const readIndex = (time - this.delaySamples) % this.bufferLength;
                for (let ch = 0; ch < this.channels; ch++) {
                    output[ch][frame] = this.buffers[ch][readIndex] * this.gain;
                }
            }
            this.position++;
        }
        return output;
    }
}
