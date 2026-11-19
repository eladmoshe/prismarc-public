import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invalidateSidebarFavicons, setSidebarFavicon } from '../../sidebar-favicon.js';

function stubExtensionUrl(t) {
    const previousChrome = globalThis.chrome;
    globalThis.chrome = { runtime: { getURL: path => 'chrome-extension://test' + path } };
    t.after(() => { globalThis.chrome = previousChrome; });
}

test('a native favicon change refreshes extension-local requests for every size on the same site', t => {
    stubExtensionUrl(t);
    const page = 'https://example.test/home';
    const savedPage = 'https://example.test/saved';
    const row = {}, favorite = {}, unrelated = {};
    setSidebarFavicon(row, page);
    setSidebarFavicon(favorite, savedPage, '96');
    const initialURL = new URL(row.src);
    assert.equal(initialURL.protocol, 'chrome-extension:');
    assert.equal(initialURL.pathname, '/_favicon/');
    assert.equal(initialURL.searchParams.get('pageUrl'), page);
    const originalFavoriteURL = favorite.src;
    const initialLoad = row.onload;
    setSidebarFavicon(row, page);
    assert.equal(row.onload, initialLoad);

    invalidateSidebarFavicons(page);
    setSidebarFavicon(row, page);
    setSidebarFavicon(favorite, savedPage, '96');
    setSidebarFavicon(unrelated, 'https://another.test/home');
    assert.notEqual(row.src, initialURL.href);
    assert.notEqual(favorite.src, originalFavoriteURL);
    const rowRevision = new URL(row.src).searchParams.get('revision');
    const favoriteURL = new URL(favorite.src);
    assert.ok(rowRevision);
    assert.equal(favoriteURL.searchParams.get('revision'), rowRevision);
    assert.equal(favoriteURL.searchParams.get('size'), '96');
    assert.equal(new URL(unrelated.src).searchParams.get('revision'), null);
});

test('refreshes a pending site revision and ignores old callbacks after navigation', t => {
    stubExtensionUrl(t);
    const original = 'https://nav.test/old';
    const next = 'https://second.test/new';
    const image = {};
    setSidebarFavicon(image, original);
    image.currentSrc = image.src;
    const previousSource = image.src;
    invalidateSidebarFavicons(original);
    image.onload();
    assert.notEqual(image.src, previousSource);
    assert.ok(new URL(image.src).searchParams.get('revision'));

    const previousLoad = image.onload;
    const previousError = image.onerror;
    setSidebarFavicon(image, next);
    previousLoad();
    previousError();
    assert.equal(new URL(image.src).searchParams.get('pageUrl'), next);
    assert.ok(image.onload);
    image.currentSrc = image.src;
    image.onload();
    assert.equal(image.onload, null);
});

test('a failed local favicon falls back to the packaged icon once', t => {
    stubExtensionUrl(t);
    const image = {};
    setSidebarFavicon(image, 'https://fallback.test');
    image.onerror();
    assert.equal(image.src, 'assets/default_icon.png');
    assert.equal(image.onerror, null);
    assert.equal(image.onload, null);
});

test('the site revision history stays bounded', t => {
    stubExtensionUrl(t);
    for (let index = 0; index < 300; index++) invalidateSidebarFavicons(`https://site-${index}.test`);
    const oldest = {}, newest = {};
    setSidebarFavicon(oldest, 'https://site-0.test');
    setSidebarFavicon(newest, 'https://site-299.test');
    assert.equal(new URL(oldest.src).searchParams.get('revision'), null);
    assert.ok(new URL(newest.src).searchParams.get('revision'));
});
