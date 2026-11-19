import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toggleQuickSwitcher } from '../../quick-switcher-window.js';

function fixture() {
    let source = { id: 1, left: -1440, top: 60, width: 1440, height: 900 };
    let popups = [];
    const calls = [];
    const page = 'chrome-extension://arcify/quick-switcher.html';
    const url = `${page}?windowId=1`;
    const api = {
        runtime: { getURL: path => `chrome-extension://arcify/${path}` },
        tabs: { update: async (id, options) => { calls.push(['tab-update', id, options]); } },
        windows: {
            getLastFocused: async () => source,
            getAll: async () => popups,
            create: async options => { calls.push(['create', options]); },
            update: async (id, options) => { calls.push(['update', id, options]); },
            remove: async id => { calls.push(['remove', id]); },
        },
    };
    return { api, calls, setSource: value => { source = value; },
        setPopups: value => { popups = value; }, url, page };
}

test('palette opens centered on the invoking Chrome window, including negative monitor coordinates', async () => {
    const { api, calls, url } = fixture();
    await toggleQuickSwitcher(api);
    assert.deepEqual(calls, [['create', { url, type: 'popup', incognito: false, width: 640, height: 560,
        left: -1040, top: 230, focused: true }]]);
});

test('existing palette is reused after a worker restart and unrelated popup URLs are ignored', async () => {
    const f = fixture();
    f.setPopups([{ id: 40, tabs: [{ id: 100, url: `${f.page}.other` }] }, { id: 41, tabs: [{ id: 101, url: f.url }] }]);
    await toggleQuickSwitcher(f.api);
    assert.deepEqual(f.calls[0], ['tab-update', 101, { url: f.url }]);
    assert.equal(f.calls[1][0], 'update');
    assert.equal(f.calls[1][1], 41);
    assert.equal(f.calls[1][2].focused, true);
    f.setSource({ id: 41 });
    await toggleQuickSwitcher(f.api);
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
    assert.equal(f.calls[1].url, f.url);
    assert.equal(f.calls[1].focused, true);
});

test('an explicit invoking window wins over stale global focus when opening from a sidebar', async () => {
    const f = fixture();
    f.api.windows.get = async id => ({ id, left: 0, top: 0, width: 800, height: 600 });
    await toggleQuickSwitcher(f.api, 9);
    assert.equal(f.calls[0][1].url, `${f.page}?windowId=9`);
    assert.equal(f.calls[0][1].left, 80);
});
