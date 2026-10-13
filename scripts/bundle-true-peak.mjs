import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Build a single self-contained AudioWorklet file, so worklet module loading
// does not depend on relative imports across extension/page origins.
const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) throw Error('Usage: node bundle-true-peak.mjs <DSP path> <output path>');
const source = readFileSync(resolve(sourcePath), 'utf8');
if (!source.includes('export class LookaheadTruePeakLimiter')) {
    throw Error('The expected DSP class was not found; refusing to create a broken worklet');
}
const dsp = source.replace('export class LookaheadTruePeakLimiter', 'class LookaheadTruePeakLimiter');
const processor = `
class VolumeControlTruePeakProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const config = options && options.processorOptions || {};
        const channels = Number(config.channels);
        this.channelCount = Number.isInteger(channels) && channels >= 1 && channels <= 8 ? channels : 2;
        this.limiter = new LookaheadTruePeakLimiter({
            sampleRate,
            channels: this.channelCount,
            ceilingDb: Number.isFinite(config.ceilingDb) ? config.ceilingDb : -1
        });
        this.failed = false;
        this.port.onmessage = event => {
            const data = event && event.data || {};
            if (data.type === 'reset') {
                this.limiter.reset();
            } else if (data.type === 'set-ceiling') {
                const ceiling = Number(data.ceilingDb);
                if (Number.isFinite(ceiling) && ceiling >= -12 && ceiling <= -0.1) {
                    this.limiter.ceilingDb = ceiling;
                    this.limiter.limit = Math.pow(10, (ceiling - 0.75) / 20);
                }
            }
        };
    }
    process(inputs, outputs) {
        const input = inputs[0], output = outputs[0];
        if (!output) return true;
        if (!input || input.length === 0) {
            for (const channel of output) channel.fill(0);
            return true;
        }
        if (this.failed || input.length !== this.channelCount || output.length !== this.channelCount) {
            for (const channel of output) channel.fill(0);
            return true;
        }
        try {
            this.limiter.processInto(input, output);
        } catch (error) {
            // Never send an unbounded boosted sample straight to the destination
            // on failure. An eventual runtime integration must bypass/recover
            // explicitly and preserve graph ownership.
            this.failed = true;
            for (const channel of output) channel.fill(0);
            this.port.postMessage({
                type: 'limiter-error',
                message: String(error && error.message || error).slice(0, 160)
            });
        }
        return true;
    }
}
registerProcessor('volume-control-true-peak', VolumeControlTruePeakProcessor);
`;
writeFileSync(resolve(outputPath), dsp + '\n' + processor, 'utf8');
