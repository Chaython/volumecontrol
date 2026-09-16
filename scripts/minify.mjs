import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Script } from 'node:vm';

async function main() {
    const { minify } = await import('terser').catch(error => {
        if (error.code === 'ERR_MODULE_NOT_FOUND') {
            throw new Error('Terser is missing. Run npm ci in the repository root before building.');
        }
        throw error;
    });

    const packageDir = process.argv[2];
    if (packageDir === '--check') return;
    if (!packageDir || process.argv.length !== 3) {
        throw new Error('Usage: node scripts/minify.mjs <package-directory>');
    }

    for (const file of await readdir(packageDir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.js')) continue;
        const filePath = join(packageDir, file.name);
        const source = await readFile(filePath, 'utf8');
        try {
            const result = await minify({ [file.name]: source }, {
                // Only remove comments and unnecessary whitespace. Keep names and
                // expressions intact across the extension's separate script files.
                compress: false,
                mangle: false,
                format: { comments: false },
            });
            new Script(result.code, { filename: file.name });
            await writeFile(filePath, result.code + '\n', 'utf8');
        } catch (error) {
            throw new Error(`Could not minify ${file.name}: ${error.message}`);
        }
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
