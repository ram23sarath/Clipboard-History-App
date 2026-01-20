/**
 * CloudClip Build Helper Script
 * Handles production bundling, version bumping, and development watch mode
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// Parse command line arguments
const args = process.argv.slice(2);
const isProduction = args.includes('--production') || args.includes('-p');
const isWatch = args.includes('--watch') || args.includes('-w');
const versionBump = args.find(arg => arg.startsWith('--version='))?.split('=')[1];

/**
 * Main build function
 */
async function build() {
    console.log('\n🔨 CloudClip Build Script\n');
    console.log(`Mode: ${isProduction ? 'Production' : 'Development'}`);

    try {
        // Bump version if requested
        if (versionBump) {
            await bumpVersion(versionBump);
        }

        // Validate config
        if (isProduction) {
            validateConfig();
        }

        // Clean dist directory
        cleanDist();

        // Copy files
        copyFiles();

        // Generate icons if needed
        await generateIcons();

        // Validate manifest
        validateManifest();

        console.log('\n✅ Build completed successfully!\n');

        if (isProduction) {
            console.log(`📦 Production build ready in: ${DIST_DIR}`);
            console.log('\nNext steps:');
            console.log('1. Go to chrome://extensions');
            console.log('2. Enable Developer Mode');
            console.log('3. Click "Load unpacked" and select the dist folder');
            console.log('\nFor Chrome Web Store submission, create a ZIP of the dist folder.');
        }

    } catch (error) {
        console.error('\n❌ Build failed:', error.message);
        process.exit(1);
    }
}

/**
 * Clean the dist directory
 */
function cleanDist() {
    console.log('🗑️  Cleaning dist directory...');

    if (fs.existsSync(DIST_DIR)) {
        fs.rmSync(DIST_DIR, { recursive: true });
    }

    fs.mkdirSync(DIST_DIR, { recursive: true });
}

/**
 * Copy files to dist
 */
function copyFiles() {
    console.log('📁 Copying files...');

    const filesToCopy = [
        'manifest.json',
        'src',
        'docs',
        'icons',
    ];

    for (const file of filesToCopy) {
        const src = path.join(ROOT_DIR, file);
        const dest = path.join(DIST_DIR, file);

        if (!fs.existsSync(src)) {
            console.log(`   ⚠️  Skipping ${file} (not found)`);
            continue;
        }

        copyRecursive(src, dest);
        console.log(`   ✓ ${file}`);
    }

    // For production, remove test files and comments
    if (isProduction) {
        console.log('🔧 Optimizing for production...');
        // In a real build, you'd use a bundler/minifier here
        // For this simple build, we just copy files as-is
    }
}

/**
 * Recursively copy files/directories
 */
function copyRecursive(src, dest) {
    const stats = fs.statSync(src);

    if (stats.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        const files = fs.readdirSync(src);

        for (const file of files) {
            // Skip test files in production
            if (isProduction && (file.endsWith('.test.js') || file === 'tests')) {
                continue;
            }
            copyRecursive(path.join(src, file), path.join(dest, file));
        }
    } else {
        fs.copyFileSync(src, dest);
    }
}

/**
 * Generate placeholder icons if they don't exist
 */
async function generateIcons() {
    const iconDir = path.join(ROOT_DIR, 'icons');

    if (!fs.existsSync(iconDir)) {
        console.log('🎨 Creating icons directory with placeholders...');
        fs.mkdirSync(iconDir, { recursive: true });

        // Create a simple SVG-based icon
        const sizes = [16, 32, 48, 128];

        for (const size of sizes) {
            const iconPath = path.join(iconDir, `icon${size}.png`);

            if (!fs.existsSync(iconPath)) {
                // Create a simple placeholder - in production, replace with real icons
                console.log(`   ⚠️  Please add icon${size}.png to the icons folder`);
            }
        }

        // Copy to dist
        const distIconDir = path.join(DIST_DIR, 'icons');
        if (fs.existsSync(iconDir)) {
            copyRecursive(iconDir, distIconDir);
        }
    }
}

/**
 * Validate the manifest.json
 */
function validateManifest() {
    console.log('📋 Validating manifest...');

    const manifestPath = path.join(DIST_DIR, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    const required = ['manifest_version', 'name', 'version', 'background', 'action'];
    const missing = required.filter(key => !manifest[key]);

    if (missing.length > 0) {
        throw new Error(`Manifest missing required fields: ${missing.join(', ')}`);
    }

    if (manifest.manifest_version !== 3) {
        throw new Error('Manifest version must be 3');
    }

    console.log(`   ✓ Manifest valid (v${manifest.version})`);
}

/**
 * Validate that config has real values
 */
function validateConfig() {
    console.log('🔐 Validating configuration...');

    const configPath = path.join(ROOT_DIR, 'src', 'config.js');
    const configContent = fs.readFileSync(configPath, 'utf-8');

    if (configContent.includes('your-project-id.supabase.co')) {
        throw new Error('SUPABASE_URL is not configured! Please update src/config.js');
    }

    if (configContent.includes('your-anon-key-here')) {
        throw new Error('SUPABASE_ANON_KEY is not configured! Please update src/config.js');
    }

    console.log('   ✓ Configuration valid');
}

/**
 * Bump the version number
 */
async function bumpVersion(type) {
    console.log(`📈 Bumping version (${type})...`);

    const manifestPath = path.join(ROOT_DIR, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    const [major, minor, patch] = manifest.version.split('.').map(Number);

    let newVersion;
    switch (type) {
        case 'major':
            newVersion = `${major + 1}.0.0`;
            break;
        case 'minor':
            newVersion = `${major}.${minor + 1}.0`;
            break;
        case 'patch':
        default:
            newVersion = `${major}.${minor}.${patch + 1}`;
    }

    manifest.version = newVersion;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Also update package.json
    const packagePath = path.join(ROOT_DIR, 'package.json');
    if (fs.existsSync(packagePath)) {
        const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
        pkg.version = newVersion;
        fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
    }

    console.log(`   ✓ Version bumped to ${newVersion}`);
}

/**
 * Watch mode (simple implementation)
 */
function watchMode() {
    console.log('\n👀 Watch mode enabled. Watching for changes...\n');
    console.log('Press Ctrl+C to stop.\n');

    const watchDirs = ['src', 'manifest.json'];

    for (const dir of watchDirs) {
        const watchPath = path.join(ROOT_DIR, dir);

        if (fs.existsSync(watchPath)) {
            fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
                if (filename) {
                    console.log(`\n📝 Change detected: ${filename}`);
                    console.log('Rebuilding...');
                    build();
                }
            });
        }
    }
}

// Run build
build().then(() => {
    if (isWatch) {
        watchMode();
    }
});
