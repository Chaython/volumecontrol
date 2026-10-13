/**
 * Offline-only 4x polyphase FIR inter-sample peak estimator.
 *
 * This is a diagnostic / test utility, not a runtime limiter or certified
 * BS.1770 meter. It uses windowed-sinc reconstruction over 24 source samples
 * and measures each channel independently (never mono-downmixes stereo).
 * The browser's existing analyser meters continue to report sample peaks.
 *
 * This belongs under scripts/ deliberately: no extra worklet permissions,
 * asynchronous graph rewiring, or additional live playback latency.
 */
const TAP_RADIUS = 12;
const OVERSAMPLE = 4;

function sinc(x) {
    if (Math.abs(x) < 1e-12) return 1;
    const piX = Math.PI * x;
    return Math.sin(piX) / piX;
}

function blackmanWindow(distance) {
    if (Math.abs(distance) >= TAP_RADIUS) return 0;
    const phase = Math.PI * distance / TAP_RADIUS;
    return 0.42 + 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
}

const phases = [1, 2, 3].map(quarter => {
    const fractional = quarter / OVERSAMPLE;
    const weights = [];
    let sum = 0;
    for (let offset = -TAP_RADIUS + 1; offset <= TAP_RADIUS; offset++) {
        const delta = fractional - offset;
        const weight = sinc(delta) * blackmanWindow(delta);
        weights.push(weight);
        sum += weight;
    }
    // Unity gain at DC despite the truncated reconstruction filter.
    return Float64Array.from(weights.map(x => x / sum));
});

const ampToDb = value => value > 0 ? 20 * Math.log10(value) : -Infinity;

export function estimateInterSamplePeaks(channels) {
    if (!Array.isArray(channels) || channels.length < 1 ||
        channels.length > 32 ||
        !channels.every(c => (c instanceof Float32Array || c instanceof Float64Array))) {
        throw new TypeError('Provide 1–32 Float32Array/Float64Array channels');
    }
    const frames = channels[0].length;
    if (frames === 0 || channels.some(c => c.length !== frames)) {
        throw new RangeError('Each channel must have the same non-zero frame length');
    }
    let samplePeak = 0;
    let interpolatedPeak = 0;
    const byChannel = [];
    for (const samples of channels) {
        let channelSample = 0;
        let channelInterpolated = 0;
        for (let n = 0; n < frames; n++) {
            const value = samples[n];
            if (!Number.isFinite(value)) throw new RangeError('Non-finite PCM sample');
            channelSample = Math.max(channelSample, Math.abs(value));
        }
        channelInterpolated = channelSample;
        for (let n = 0; n < frames - 1; n++) {
            for (const weights of phases) {
                let reconstructed = 0;
                // The FIR window is finite, with silence outside the supplied
                // buffer. Include margins around test clips to avoid treating
                // the first/last fixture frames as arbitrary hard cuts.
                for (let tap = 0; tap < weights.length; tap++) {
                    const idx = n + tap - TAP_RADIUS + 1;
                    if (idx >= 0 && idx < frames) reconstructed += weights[tap] * samples[idx];
                }
                channelInterpolated = Math.max(channelInterpolated, Math.abs(reconstructed));
            }
        }
        samplePeak = Math.max(samplePeak, channelSample);
        interpolatedPeak = Math.max(interpolatedPeak, channelInterpolated);
        byChannel.push({
            samplePeak: channelSample,
            interpolatedPeak: channelInterpolated
        });
    }
    return {
        samplePeak,
        interpolatedPeak,
        samplePeakDb: ampToDb(samplePeak),
        interpolatedPeakDb: ampToDb(interpolatedPeak),
        interSampleOvershootDb: samplePeak > 0
            ? ampToDb(interpolatedPeak / samplePeak) : 0,
        channels: byChannel,
        oversamplingFactor: OVERSAMPLE,
        compliantTruePeakMeter: false
    };
}
