import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Script } from 'node:vm';

async function importBuildDependency(name, displayName) {
    try {
        return await import(name);
    } catch (error) {
        if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
            throw new Error(`${displayName} is missing. Run npm ci in the repository root before building.`);
        }
        throw error;
    }
}

async function loadMinifiers() {
    const terserModule = await importBuildDependency('terser', 'Terser');
    const cleanCssModule = await importBuildDependency('clean-css', 'clean-css');
    const htmlMinifierModule = await importBuildDependency('html-minifier-terser', 'html-minifier-terser');

    const CleanCSS = cleanCssModule.default || cleanCssModule.CleanCSS;
    if (typeof terserModule.minify !== 'function') throw new Error('Terser did not expose minify().');
    if (typeof CleanCSS !== 'function') throw new Error('clean-css did not expose its minifier constructor.');
    if (typeof htmlMinifierModule.minify !== 'function') throw new Error('html-minifier-terser did not expose minify().');

    return {
        minifyJavaScript: terserModule.minify,
        CleanCSS,
        minifyHtml: htmlMinifierModule.minify,
    };
}

async function minifyJavaScript(fileName, source, minify) {
    const result = await minify({ [fileName]: source }, {
        // Keep runtime semantics conservative across the extension's separate
        // execution contexts. Terser only removes comments/whitespace here.
        compress: false,
        mangle: false,
        format: { comments: false },
    });
    if (!result.code) throw new Error('Terser produced no output.');
    new Script(result.code, { filename: fileName });
    return result.code + '\n';
}

function minifyCss(fileName, source, CleanCSS) {
    // Level 1 removes comments/whitespace and performs local value cleanup
    // without cross-rule restructuring. rebase:false preserves extension URLs.
    const result = new CleanCSS({
        level: 1,
        rebase: false,
        format: false,
    }).minify(source);

    if (result.errors && result.errors.length) {
        throw new Error(result.errors.join('; '));
    }
    if (!result.styles) throw new Error('clean-css produced no output.');
    return result.styles + '\n';
}

async function minifyHtml(fileName, source, minify) {
    const result = await minify(source, {
        collapseWhitespace: true,
        conservativeCollapse: true,
        removeComments: true,
        keepClosingSlash: true,
        removeAttributeQuotes: false,
        removeEmptyAttributes: false,
        removeOptionalTags: false,
        removeRedundantAttributes: false,
        sortAttributes: false,
        sortClassName: false,
        // Standalone JS and CSS are minified by their dedicated tools. Do not
        // run a second parser over inline content if it is added later.
        minifyCSS: false,
        minifyJS: false,
    });
    if (!result) throw new Error('html-minifier-terser produced no output.');
    return result + '\n';
}

async function main() {
    const minifiers = await loadMinifiers();

    const packageDir = process.argv[2];
    if (packageDir === '--check') return;
    if (!packageDir || process.argv.length !== 3) {
        throw new Error('Usage: node scripts/minify.mjs <package-directory>');
    }

    for (const file of await readdir(packageDir, { withFileTypes: true })) {
        if (!file.isFile()) continue;

        const extension = extname(file.name).toLowerCase();
        if (!['.js', '.css', '.html'].includes(extension)) continue;

        const filePath = join(packageDir, file.name);
        const source = await readFile(filePath, 'utf8');

        try {
            let output;
            if (extension === '.js') {
                output = await minifyJavaScript(file.name, source, minifiers.minifyJavaScript);
            } else if (extension === '.css') {
                output = minifyCss(file.name, source, minifiers.CleanCSS);
            } else {
                output = await minifyHtml(file.name, source, minifiers.minifyHtml);
            }
            await writeFile(filePath, output, 'utf8');
        } catch (error) {
            throw new Error(`Could not minify ${file.name}: ${error.message}`);
        }
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
