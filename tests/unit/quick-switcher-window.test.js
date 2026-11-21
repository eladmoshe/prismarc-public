import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeQuickSwitcherWindow, confirmQuickSwitcherDeletion, forgetQuickSwitcherPrompt,
    toggleQuickSwitcher } from '../../quick-switcher-window.js';

function fixture() {
    let source = { id: 1, left: -1440, top: 60, width: 1440, height: 900 };
    let popups = [];
    const stored = {};
    const calls = [];
    const page = 'chrome-extension://arcify/quick-switcher.html';
    const url = `${page}?windowId=1`;
    const api = {
        runtime: { id: 'arcify' },
        storage: { session: { get: async key => ({ [key]: stored[key] }), set: async changes => Object.assign(stored, changes) } },
        tabs: { update: async (id, options) => { calls.push(['tab-update', id, options]); } },
        windows: {
            getLastFocused: async () => source,
            get: async id => [source, ...popups].find(window => window.id === id),
            getAll: async () => popups,
            create: async options => { calls.push(['create', options]); return { id: 77, type: 'popup' }; },
            update: async (id, options) => { calls.push(['update', id, options]); },
            remove: async id => { calls.push(['remove', id]); },
        },
    };
    return { api, calls, setSource: value => { source = value; },
        setPopups: value => { popups = value; }, url, page, stored };
}

test('palette opens centered on the invoking Chrome window, including negative monitor coordinates', async () => {
    const { api, calls, url, stored } = fixture();
    assert.equal(await toggleQuickSwitcher(api), true);
    assert.match(stored.quickSwitcherWindow.nonce, /^[a-f0-9-]{36}$/);
    assert.equal(stored.quickSwitcherWindow.popupId, 77);
    assert.deepEqual(calls, [['create', { url: `${url}&invocation=${stored.quickSwitcherWindow.nonce}`, type: 'popup', incognito: false, width: 640, height: 560,
        left: -1040, top: 230, focused: true }]]);
});

test('existing palette is reused after a worker restart and unrelated popup URLs are ignored', async () => {
    const f = fixture();
    f.setPopups([{ id: 40, tabs: [{ id: 100, url: `${f.page}.other` }] }, { id: 41, tabs: [{ id: 101, url: f.url }] }]);
    await toggleQuickSwitcher(f.api);
    assert.deepEqual(f.calls[0], ['tab-update', 101, { url: `${f.url}&invocation=${f.stored.quickSwitcherWindow.nonce}` }]);
    assert.equal(f.calls[1][0], 'update');
    assert.equal(f.calls[1][1], 41);
    assert.equal(f.calls[1][2].focused, true);
    assert.equal(f.stored.quickSwitcherWindow.popupId, 41);
    f.setSource({ id: 41 });
    assert.equal(await toggleQuickSwitcher(f.api), true);
    assert.deepEqual(f.calls[2], ['remove', 41]);
});

test('rapid shortcut events serialize creation and the following toggle closes the same palette', async () => {
    const f = fixture();
    f.api.windows.create = async options => {
        await new Promise(resolve => setTimeout(resolve, 5));
        f.calls.push(['create', options]);
        const popup = { id: 42, tabs: [{ url: f.url }] };
        f.setSource(popup);
        f.setPopups([popup]);
    };
    await Promise.all([toggleQuickSwitcher(f.api), toggleQuickSwitcher(f.api)]);
    assert.deepEqual(f.calls.map(call => call[0]), ['create', 'remove']);
    assert.equal(f.calls[1][1], 42);
});

test('a failed window operation does not disable the next shortcut', async () => {
    const f = fixture();
    const create = f.api.windows.create;
    f.api.windows.create = async () => { throw new Error('Window closed during shortcut'); };
    await assert.rejects(toggleQuickSwitcher(f.api), /Window closed/);
    f.api.windows.create = create;
    await toggleQuickSwitcher(f.api);
    assert.equal(f.calls[0][0], 'create');
});

test('a failed renderer binding removes its empty popup and does not disable the next shortcut', async () => {
    const f = fixture();
    const set = f.api.storage.session.set;
    f.api.storage.session.set = async () => { throw new Error('Session storage unavailable'); };
    await assert.rejects(toggleQuickSwitcher(f.api), /Session storage unavailable/);
    assert.deepEqual(f.calls.map(call => call[0]), ['create', 'remove']);
    assert.deepEqual(f.calls[1], ['remove', 77]);
    f.api.storage.session.set = set;
    await toggleQuickSwitcher(f.api);
    assert.equal(f.calls[2][0], 'create');
});

test('offscreen coordinates fall back to Chrome placement without weakening unrelated error handling', async () => {
    const f = fixture();
    f.api.windows.create = async options => {
        f.calls.push(options);
        if ('left' in options) throw new Error('Invalid value for bounds. Bounds must be at least 50% within visible screen space.');
    };
    await toggleQuickSwitcher(f.api);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].left, undefined);
    assert.equal(f.calls[1].top, undefined);
    assert.equal(new URL(f.calls[1].url).searchParams.get('windowId'), '1');
    assert.equal(f.calls[1].focused, true);
});

test('an explicit invoking window wins over stale global focus when opening from a sidebar', async () => {
    const f = fixture();
    f.api.windows.get = async id => ({ id, left: 0, top: 0, width: 800, height: 600 });
    await toggleQuickSwitcher(f.api, 9);
    assert.equal(new URL(f.calls[0][1].url).searchParams.get('windowId'), '9');
    assert.equal(f.calls[0][1].left, 80);
});

test('only the created native window and exact renderer URL can load the search', async () => {
    const f = fixture();
    await toggleQuickSwitcher(f.api);
    f.setPopups([{ id: 77, type: 'popup' }, { id: 88, type: 'popup' }]);
    const sender = { id: 'arcify', tab: { windowId: 77 }, frameId: 0, documentLifecycle: 'active', url: f.calls[0][1].url };
    assert.deepEqual(await authorizeQuickSwitcherWindow(f.api, sender), { windowId: 1, incognito: false });
    for (const change of [{ tab: { windowId: 88 } }, { frameId: 3 }, { id: 'unrelated' }, { url: f.url }]) {
        assert.deepEqual(await authorizeQuickSwitcherWindow(f.api, { ...sender, ...change }), {});
    }
});

test('Quick Switcher prefers the focused source tab inline and never falls back over a later tab', async () => {
    const f = fixture();
    const active = { id: 32, windowId: 1, active: true };
    f.setSource({ id: 1, type: 'normal', focused: true, tabs: [active] });
    assert.equal(await toggleQuickSwitcher(f.api, 1, { async openSearch(tab) {
        assert.equal(tab, active);
        return true;
    } }), true);
    assert.equal(await toggleQuickSwitcher(f.api, 1, { async openSearch() {
        f.setSource({ id: 1, focused: true, tabs: [{ id: 33, active: true }] });
        return false;
    } }), false);
    assert.deepEqual(f.calls, []);
});

test('a failed inline invocation does not pop up over a new route in the same tab or a different focused window', async () => {
    const f = fixture();
    const active = { id: 32, windowId: 1, active: true, url: 'https://source.test/start' };
    f.setSource({ id: 1, type: 'normal', focused: true, tabs: [active] });
    assert.equal(await toggleQuickSwitcher(f.api, 1, { async openSearch() {
        f.setSource({ id: 1, type: 'normal', focused: true, tabs: [{ ...active, url: 'https://source.test/later' }] });
        return false;
    } }), false);
    f.api.windows.get = async () => ({ id: 1, type: 'normal', focused: false, tabs: [active] });
    f.setSource({ id: 2, type: 'normal', focused: true, tabs: [] });
    assert.equal(await toggleQuickSwitcher(f.api, 1), false);
    assert.deepEqual(f.calls, []);
});

test('Quick Switcher falls back for an unchanged pending navigation and cancels if its destination changes', async () => {
    const f = fixture();
    const active = { id: 32, windowId: 1, active: true, url: 'https://source.test/start',
        pendingUrl: 'https://source.test/pending' };
    const source = { id: 1, type: 'normal', focused: true, tabs: [active] };
    f.setSource(source);
    assert.equal(await toggleQuickSwitcher(f.api, 1, { async openSearch() {
        f.setSource({ ...source, tabs: [{ ...active, pendingUrl: 'https://source.test/later' }] });
        return false;
    } }), false);
    assert.deepEqual(f.calls, []);
    f.setSource(source);
    assert.equal(await toggleQuickSwitcher(f.api, 1, { openSearch: async () => false }), true);
    assert.deepEqual(f.calls.map(([operation]) => operation), ['create']);
});

test('a history confirmation stays in the owning native window and can be read only once', async () => {
    const f = fixture();
    f.setSource({ id: 1, type: 'normal', focused: true });
    f.setPopups([{ id: 77, type: 'popup' }]);
    const tab = { id: 32, windowId: 1, url: 'https://source.test/' };
    const draft = { query: 'Synthetic query', urls: ['https://history.test/visited'] };
    assert.equal(await confirmQuickSwitcherDeletion(f.api, tab, draft, async () => false), false);
    assert.deepEqual(f.calls, []);
    assert.equal(await confirmQuickSwitcherDeletion(f.api, tab, draft, async () => true), true);
    const sender = { id: 'arcify', tab: { windowId: 77 }, frameId: 0, documentLifecycle: 'active', url: f.calls[0][1].url };
    assert.ok(!sender.url.includes('Synthetic') && !sender.url.includes('history.test'));
    assert.deepEqual(await authorizeQuickSwitcherWindow(f.api, sender), { windowId: 1, incognito: false,
        deletion: { ...draft, source: { id: tab.id, url: tab.url } } });
    assert.deepEqual(await authorizeQuickSwitcherWindow(f.api, sender), { windowId: 1, incognito: false });

    assert.equal(await confirmQuickSwitcherDeletion(f.api, tab, draft, async () => true), true);
    forgetQuickSwitcherPrompt(77);
    assert.deepEqual(await authorizeQuickSwitcherWindow(f.api, { ...sender, url: f.calls[1][1].url }),
        { windowId: 1, incognito: false });
});
