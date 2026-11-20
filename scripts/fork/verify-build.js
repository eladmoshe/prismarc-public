import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { storeBuildDirectory, storeManifest } from './chrome-web-store-build.js';

const isStore = process.argv.includes('--chrome-web-store');
const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.join(root, isStore ? storeBuildDirectory : 'dist');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

async function requireFile(reference, from = path.join(dist, 'manifest.json')) {
  if (!reference || reference.startsWith('#') || reference.startsWith('data:')) return;
  assert(!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference),
    `Remote resource in ${path.relative(dist, from)}: ${reference}`);
  const pathname = decodeURIComponent(reference.split(/[?#]/)[0]);
  const target = pathname.startsWith('/')
    ? path.resolve(dist, `.${pathname}`)
    : path.resolve(path.dirname(from), pathname);
  assert(target.startsWith(`${dist}${path.sep}`), `Resource escapes the build directory: ${reference}`);
  assert((await stat(target).catch(() => null))?.isFile(),
    `Missing resource in ${path.relative(dist, from)}: ${reference}`);
}

async function verifyBuild() {
  const manifest = await readJson(path.join(dist, 'manifest.json'));
  const source = await readJson(path.join(root, 'manifest.json'));
  assert(isDeepStrictEqual(manifest, isStore ? storeManifest(source) : source),
    'Built manifest differs from source; rebuild before installing.');
  assert.equal(manifest.manifest_version, 3, 'Expected a Manifest V3 extension.');

  const actionIcons = manifest.action?.default_icon;
  const declaredFiles = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    manifest.options_page,
    manifest.options_ui?.page,
    manifest.action?.default_popup,
    ...(typeof actionIcons === 'string' ? [actionIcons] : Object.values(actionIcons ?? {})),
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.chrome_url_overrides ?? {}),
    ...(manifest.content_scripts ?? []).flatMap(entry => [...(entry.js ?? []), ...(entry.css ?? [])]),
    ...(manifest.web_accessible_resources ?? []).flatMap(entry => entry.resources),
    'tab-switcher-inline.js',
    // These pages are opened from runtime code rather than declared in the manifest.
    'installation-onboarding.html',
    'tutorial-practice.html',
    'offscreen.html',
    'quick-switcher.html',
    'tab-switcher.html',
    ...(!isStore ? ['calendar-settings.html'] : []),
    // Runtime-generated URLs and the required distribution notices.
    'assets/default_icon.png',
    'assets/icon-48.png',
    'assets/varela-round-LICENSE.txt',
    'LICENSE',
    'NOTICE',
  ];
  for (const file of declaredFiles) await requireFile(file);

  const entries = await readdir(dist, { recursive: true });
  if (isStore) {
    const onboarding = await readFile(path.join(dist, 'installation-onboarding.html'), 'utf8');
    assert.match(onboarding, /Keep PrismArc on your toolbar/, 'Store onboarding is missing the toolbar pin guide.');
    assert.doesNotMatch(onboarding, /setup-gif|Pause animation/, 'Store onboarding includes animation controls.');
    const onboardingScript = await readFile(path.join(dist, 'installation-onboarding.js'), 'utf8');
    assert.doesNotMatch(onboardingScript, /chrometutorial|setup-gif/, 'Store onboarding still references the legacy recording.');
  }
  for (const entry of entries) {
    const file = path.join(dist, entry);
    if (isStore) {
      assert(!/\.gif$/i.test(entry), `Unreviewed animation in store build: ${entry}`);
      assert(!/(^|\/)calendar-/.test(entry), `Calendar file in store build: ${entry}`);
      if (/\.(?:css|html|js|json)$/.test(entry)) {
        const contents = await readFile(file, 'utf8');
        assert(!/googleapis\.com\/(?:calendar|revoke)|accounts\.google\.com\/o\/oauth2|chromiumapp\.org|launchWebAuthFlow|apps\.googleusercontent\.com|calendar-settings\.html|calendar-preview|calendarPreview|data-calendar-favorite/i.test(contents),
          `Calendar capability in store build: ${entry}`);
      }
    }
    if (entry.endsWith('.html')) {
      const html = await readFile(file, 'utf8');
      // Validate packaged resources; navigation links can intentionally open websites.
      const resources = html.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi);
      for (const match of resources) await requireFile(match[1], file);
    } else if (entry.endsWith('.css')) {
      const css = await readFile(file, 'utf8');
      for (const match of css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)) {
        await requireFile(match[1], file);
      }
    }
  }

  console.log(`Verified ${manifest.name} ${manifest.version}: manifest, runtime pages, and HTML/CSS resources.`);
  console.log(`Load unpacked in Chrome: ${dist}`);
  console.log('Open chrome://extensions, enable Developer mode, then select Load unpacked.');
  console.log('After rebuilding, click Reload on the installed extension.');
}

verifyBuild().catch(error => {
  console.error(`Build verification failed: ${error.message}`);
  process.exitCode = 1;
});
