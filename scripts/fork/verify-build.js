import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.join(root, 'dist');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

async function requireFile(reference, from = path.join(dist, 'manifest.json')) {
  if (!reference || reference.startsWith('#') || reference.startsWith('data:')) return;
  assert(!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference),
    `Remote resource in ${path.relative(dist, from)}: ${reference}`);
  const pathname = decodeURIComponent(reference.split(/[?#]/)[0]);
  const target = pathname.startsWith('/')
    ? path.resolve(dist, `.${pathname}`)
    : path.resolve(path.dirname(from), pathname);
  assert(target.startsWith(`${dist}${path.sep}`), `Resource escapes dist/: ${reference}`);
  assert((await stat(target).catch(() => null))?.isFile(),
    `Missing resource in ${path.relative(dist, from)}: ${reference}`);
}

async function verifyBuild() {
  const manifest = await readJson(path.join(dist, 'manifest.json'));
  assert(isDeepStrictEqual(manifest, await readJson(path.join(root, 'manifest.json'))),
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
    // These pages are opened from runtime code rather than declared in the manifest.
    'installation-onboarding.html',
    'tutorial-practice.html',
    'offscreen.html',
    'quick-switcher.html',
    'tab-switcher.html',
    'calendar-settings.html',
    // Runtime-generated URLs and the required distribution notices.
    'assets/default_icon.png',
    'assets/icon-48.png',
    'assets/varela-round-LICENSE.txt',
    'LICENSE',
    'NOTICE',
  ];
  for (const file of declaredFiles) await requireFile(file);

  const entries = await readdir(dist, { recursive: true });
  for (const entry of entries) {
    const file = path.join(dist, entry);
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
