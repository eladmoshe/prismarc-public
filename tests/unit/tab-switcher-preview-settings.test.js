import test from 'node:test';
import assert from 'node:assert/strict';
import { enableVisitPreviews, isBrowsingPreviewCandidate, setPreviewPreferences } from '../../tab-switcher-preview-settings.js';
import {
    TAB_SWITCHER_CAPTURE_ON_VISIT as VISIT,
    TAB_SWITCHER_PAGE_PREVIEWS as PREVIEWS,
    TAB_SWITCHER_VISIT_PERMISSION as PERMISSION,
} from '../../tab-switcher-previews.js';

test('browsing preview hints exclude only known invocation-only web origins and ineligible tabs', () => {
    const page = { id: 1, windowId: 10, incognito: false, status: 'complete', url: 'https://site.example.test/' };
    assert.equal(isBrowsingPreviewCandidate(page, []), true);
    assert.equal(isBrowsingPreviewCandidate(page, ['example.test']), false);
    assert.equal(isBrowsingPreviewCandidate({ ...page, discarded: true }, []), false);
    assert.equal(isBrowsingPreviewCandidate({ ...page, status: 'unloaded' }, []), false);
    assert.equal(isBrowsingPreviewCandidate({ ...page, incognito: true }, []), false);
    for (const url of ['chrome://settings/', 'https://chromewebstore.google.com/category/extensions', 'https://chrome.google.com/webstore']) {
        assert.equal(isBrowsingPreviewCandidate({ ...page, url }, []), false);
    }
    assert.equal(isBrowsingPreviewCandidate({ ...page, url: 'https://www.google.com/' }, []), true);
});

function fixture(settings = {}, requestAllowed = async () => true) {
    let granted = false;
    const calls = [];
    const locks = {
        async request(_name, callback) {
            calls.push('lock');
            return callback();
        },
    };
    const chrome = {
        storage: { local: {
            async get() { return { ...settings }; },
            async set(preferences) { Object.assign(settings, preferences); },
        } },
        permissions: {
            async request(permission) {
                assert.deepEqual(permission, PERMISSION);
                calls.push('request');
                granted = await requestAllowed();
                return granted;
            },
            async contains() { return granted; },
            async remove() { granted = false; },
        },
    };
    return { chrome, locks, settings, calls };
}

test('enabling visit previews requests the native all-sites grant before the settings lock', async () => {
    const f = fixture();
    const result = enableVisitPreviews(f.chrome, undefined, f.locks);
    assert.deepEqual(f.calls, ['request']);
    assert.equal(await result, 'enabled');
    assert.deepEqual(f.calls, ['request', 'lock']);
    assert.deepEqual(f.settings, { [VISIT]: true });
    await setPreviewPreferences(f.chrome, { [VISIT]: false }, f.locks);
    assert.equal(await f.chrome.permissions.contains(), false);
    assert.deepEqual(f.settings, { [VISIT]: false });
    assert.equal(await enableVisitPreviews(f.chrome, false, f.locks), 'enabled');
});

test('denied or browser-blocked permission leaves the preview preferences untouched', async () => {
    const denial = async () => false;
    const blocked = async () => { throw new Error('Host permission blocked'); };
    for (const response of [denial, blocked]) {
        const f = fixture({}, response);
        assert.equal(await enableVisitPreviews(f.chrome, undefined, f.locks), 'denied');
        assert.deepEqual(f.settings, {});
    }
});

test('an explicit Settings opt-out during sidebar consent wins and revokes the grant', async () => {
    let approve;
    const f = fixture({}, () => new Promise(resolve => { approve = resolve; }));
    const pending = enableVisitPreviews(f.chrome, undefined, f.locks);
    await setPreviewPreferences(f.chrome, { [PREVIEWS]: false, [VISIT]: false }, f.locks);
    approve(true);
    assert.equal(await pending, 'disabled');
    assert.equal(await f.chrome.permissions.contains(), false);
    assert.deepEqual(f.settings, { [PREVIEWS]: false, [VISIT]: false });
});

test('another window’s successful opt-in keeps the shared grant without another write', async () => {
    const f = fixture({ [VISIT]: true });
    f.chrome.storage.local.set = async () => { assert.fail('The stored opt-in is already current'); };
    assert.equal(await enableVisitPreviews(f.chrome, undefined, f.locks), 'enabled');
    assert.equal(await f.chrome.permissions.contains(), true);
});

test('grant is released if the local opt-in cannot be saved', async () => {
    const f = fixture();
    f.chrome.storage.local.set = async () => { throw new Error('Storage unavailable'); };
    await assert.rejects(enableVisitPreviews(f.chrome, undefined, f.locks), /Storage unavailable/);
    assert.equal(await f.chrome.permissions.contains(), false);
    assert.deepEqual(f.settings, {});
});
