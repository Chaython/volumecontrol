import { DefaultArtifactClient } from '@actions/artifact';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve('dist');
const files = readdirSync(dist)
    .filter(name => /^volume-control-(?:chrome|firefox)-v.+\.zip$/.test(name))
    .sort()
    .map(name => resolve(dist, name));

if (files.length !== 2) {
    throw new Error(`Expected exactly two extension ZIPs, found ${files.length}.`);
}

const artifact = new DefaultArtifactClient();
const result = await artifact.uploadArtifact('volume-control-packages', files, {
    retentionDays: 14,
    compressionLevel: 0
});

console.log(`Uploaded Actions artifact id=${result.id} size=${result.size} bytes`);
