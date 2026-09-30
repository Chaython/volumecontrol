import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
const installArgs = ['install', '--no-save', '--package-lock=false', '@actions/artifact@6.2.1'];
const install = process.platform === 'win32'
    ? spawnSync(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', 'npm ' + installArgs.join(' ')],
        { cwd: workspace, stdio: 'inherit', env: process.env }
    )
    : spawnSync(
        'npm',
        installArgs,
        { cwd: workspace, stdio: 'inherit', env: process.env }
    );

if (install.error) throw install.error;
if (install.status !== 0) {
    throw new Error(`Failed to install @actions/artifact (exit ${install.status}).`);
}

const { DefaultArtifactClient } = await import('@actions/artifact');
const dist = resolve(workspace, 'dist');
const files = readdirSync(dist)
    .filter(name => /^volume-control-(?:chrome|firefox)-v.+\.zip$/.test(name))
    .sort()
    .map(name => resolve(dist, name));

if (files.length !== 2) {
    throw new Error(`Expected exactly two extension ZIPs, found ${files.length}.`);
}

const artifact = new DefaultArtifactClient();
const result = await artifact.uploadArtifact('volume-control-packages', files, dist, {
    retentionDays: 14,
    compressionLevel: 0
});

console.log(`Uploaded Actions artifact id=${result.id} size=${result.size} bytes`);
