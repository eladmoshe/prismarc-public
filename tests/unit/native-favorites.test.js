import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NativeFavorites, getFavoriteDropTarget, registerNativeFavorites } from '../../native-favorites.js';

let local, session, tabs, updates;
const area = data => ({
    get: async key => structuredClone({ [key]: data[key] }),
    set: async values => Object.assign(data, structuredClone(values))
});
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
beforeEach(() => {
    local = {}; session = {}; updates = [];
    tabs = Array.from({ length: 16 }, (_, index) => ({ id: index + 1, index, windowId: 1,
        url: `https://site.test/${index + 1}?original=1#saved`, title: `Site ${index + 1}`, pinned: false }));
    globalThis.chrome = {
        storage: { local: area(local), session: area(session) },
        tabs: {
            query: async query => structuredClone(tabs.filter(tab =>
                (query.pinned === undefined || tab.pinned === query.pinned) &&
                (query.windowId === undefined || tab.windowId === query.windowId))),
            get: async id => { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Tab closed'); return structuredClone(tab); },
            update: async (id, change) => { updates.push([id, change]); const tab = tabs.find(tab => tab.id === id); Object.assign(tab, change); return structuredClone(tab); },
            onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event()
        }
    };
});

test('twelve Favorites fit; a thirteenth and an oversized batch leave existing pins unchanged', async () => {
    const store = new NativeFavorites();
    await store.dispatch({ action: 'pin', tabIds: Array.from({ length: 11 }, (_, index) => index + 1) });
    await assert.rejects(store.dispatch({ action: 'pin', tabIds: [12, 13] }), /up to 12/);
    assert.equal(tabs.filter(tab => tab.pinned).length, 11);
    await store.dispatch({ action: 'pin', tabIds: [12, 12] });
    await assert.rejects(store.dispatch({ action: 'pin', tabIds: [13] }), /up to 12/);
    assert.equal(updates.length, 12);
    assert.equal((await store.dispatch({ action: 'get', windowId: 1 })).length, 12);
});

test('concurrent panels share one capacity check and limits are per window', async () => {
    const store = new NativeFavorites();
    await store.dispatch({ action: 'pin', tabIds: Array.from({ length: 11 }, (_, index) => index + 1) });
    const result = await Promise.allSettled([12, 13].map(id => store.dispatch({ action: 'pin', tabIds: [id] })));
    assert.deepEqual(result.map(item => item.status), ['fulfilled', 'rejected']);
    tabs[13].windowId = 2;
    await store.dispatch({ action: 'pin', tabIds: [14] });
    assert.equal(tabs[13].pinned, true);
});

test('navigation and worker reload retain the exact saved URL and reset activates the same tab', async () => {
    const store = new NativeFavorites();
    const baseUrl = tabs[0].url;
    await store.dispatch({ action: 'pin', tabIds: [1] });
    tabs[0].url = 'https://other.test/navigated?new=2#away';
    const reloaded = new NativeFavorites();
    assert.equal((await reloaded.dispatch({ action: 'get' }))[0].baseUrl, baseUrl);
    await reloaded.dispatch({ action: 'reset', tabId: 1 });
    assert.equal(tabs[0].url, baseUrl);
    assert.equal(tabs[0].active, true);
    assert.equal(tabs.length, 16);
});

test('new browser session remaps saved URLs without trusting reused tab IDs', async () => {
    const store = new NativeFavorites();
    const baseUrl = tabs[0].url;
    await store.dispatch({ action: 'pin', tabIds: [1] });
    tabs[0].url = 'https://site.test/navigated';
    await store.dispatch({ action: 'get' });
    session = {}; chrome.storage.session = area(session);
    tabs = [{ ...tabs[0], id: 44 }, { id: 1, index: 1, windowId: 1, url: 'https://unrelated.test/', pinned: true }];
    const reloaded = new NativeFavorites();
    const restored = await reloaded.dispatch({ action: 'get' });
    assert.equal(restored.find(tab => tab.id === 44).baseUrl, baseUrl);
    assert.equal(restored.find(tab => tab.id === 1).baseUrl, 'https://unrelated.test/');
});

test('native pin, navigation, replacement, unpin and close are tracked with the sidebar closed', async () => {
    const store = new NativeFavorites(); store.install(); await store.chain;
    const baseUrl = tabs[0].url;
    tabs[0].pinned = true;
    chrome.tabs.onUpdated.emit(1, { pinned: true }, structuredClone(tabs[0])); await store.chain;
    tabs[0].url = 'https://site.test/elsewhere';
    chrome.tabs.onUpdated.emit(1, { url: tabs[0].url }, structuredClone(tabs[0])); await store.chain;
    assert.equal(local.nativeFavoriteSnapshot[0].baseUrl, baseUrl);
    tabs[0].id = 44;
    chrome.tabs.onReplaced.emit(44, 1); await store.chain;
    assert.equal(store.records.get(44).baseUrl, baseUrl);
    tabs[0].pinned = false;
    chrome.tabs.onUpdated.emit(44, { pinned: false }, structuredClone(tabs[0])); await store.chain;
    await store.dispatch({ action: 'pin', tabIds: [44] });
    assert.equal(store.records.get(44).baseUrl, tabs[0].url);
    tabs.shift(); chrome.tabs.onRemoved.emit(44, { isWindowClosing: false }); await store.chain;
    assert.deepEqual(local.nativeFavoriteSnapshot, []);
});

test('window closure keeps reset URLs through worker restart and later restoration', async () => {
    const store = new NativeFavorites(); store.install(); await store.chain;
    const baseUrl = tabs[0].url;
    await store.dispatch({ action: 'pin', tabIds: [1] });
    tabs.shift(); chrome.tabs.onRemoved.emit(1, { isWindowClosing: true }); await store.chain;
    const next = new NativeFavorites(); next.install(); await next.chain;
    tabs.push({ id: 44, index: 0, windowId: 2, url: baseUrl, pinned: true });
    // Only the new worker would receive the restored tab event.
    const listener = chrome.tabs.onCreated.listeners.at(-1);
    listener(tabs.at(-1)); await next.chain;
    assert.equal(next.records.get(44).baseUrl, baseUrl);
    assert.equal(next.restoreQueue.length, 0);
});

test('existing native pins above the Arcify limit remain accessible', async () => {
    tabs.forEach(tab => { tab.pinned = true; });
    const store = new NativeFavorites();
    assert.equal((await store.dispatch({ action: 'get' })).length, 16);
    assert.equal(updates.length, 0);
    const reloaded = new NativeFavorites();
    assert.equal((await reloaded.dispatch({ action: 'get' })).length, 16);
    assert.equal(updates.length, 0);
    tabs.push({ id: 17, index: 16, windowId: 1, url: 'https://site.test/new', pinned: false });
    await assert.rejects(reloaded.dispatch({ action: 'pin', tabIds: [17] }), /up to 12/);
    assert.equal(tabs.filter(tab => tab.pinned).length, 16);
    assert.equal(updates.length, 0);
});

test('Favorites messages accept only this extension and leave unrelated replies alone', async () => {
    chrome.runtime = { id: 'arcify', getURL: path => `chrome-extension://arcify/${path}`, onMessage: event() };
    registerNativeFavorites();
    const [listener] = chrome.runtime.onMessage.listeners;
    for (const sender of [{}, { id: 'other' }, { id: 'arcify', url: 'https://website.test/' }]) {
        assert.equal(listener({ type: 'nativeFavorites', action: 'pin', tabIds: [1] }, sender,
            () => assert.fail('Untrusted sender received a reply')), undefined);
    }
    assert.equal(listener({ type: 'spaceStore', action: 'get' }, { id: 'arcify' },
        () => assert.fail('Unrelated message intercepted')), undefined);
    const reply = await new Promise(resolve => {
        assert.equal(listener({ type: 'nativeFavorites', action: 'get' },
            { id: 'arcify', url: 'chrome-extension://arcify/sidebar.html' }, resolve), true);
    });
    assert.deepEqual(reply, { success: true, tabs: [] });
    assert.equal(updates.length, 0);
});

test('grid drop targets distinguish rows, row ends and gaps', () => {
    const elements = Array.from({ length: 12 }, (_, index) => ({ index, getBoundingClientRect: () => ({
        left: index % 4 * 80, right: index % 4 * 80 + 72,
        top: Math.floor(index / 4) * 56, bottom: Math.floor(index / 4) * 56 + 48
    }) }));
    const container = { querySelectorAll: () => elements };
    assert.equal(getFavoriteDropTarget(container, 20, 20).index, 0);
    assert.equal(getFavoriteDropTarget(container, 20, 80).index, 4);
    assert.equal(getFavoriteDropTarget(container, 400, 80).index, 7);
    assert.equal(getFavoriteDropTarget(container, 76, 20).index, 0);
    assert.equal(getFavoriteDropTarget(container, 20, 140).index, 8);
    assert.equal(getFavoriteDropTarget(container, 400, 140).index, 11);
    assert.equal(getFavoriteDropTarget(container, 20, 110).index, 8);
    const placeholder = {};
    assert.equal(getFavoriteDropTarget({ querySelectorAll: () => [], querySelector: () => placeholder }, 0, 0), placeholder);
});

test('Favorite queries return current audio state without persisting it into saved reset records', async () => {
    tabs[0].pinned = true;
    tabs[0].audible = true;
    tabs[0].mutedInfo = { muted: false };
    const store = new NativeFavorites();
    let [favorite] = await store.dispatch({ action: 'get', windowId: 1 });
    assert.equal(favorite.audible, true);
    tabs[0].audible = false;
    tabs[0].mutedInfo = { muted: true };
    [favorite] = await store.dispatch({ action: 'get', windowId: 1 });
    assert.equal(favorite.audible, false);
    assert.equal(favorite.mutedInfo.muted, true);
    const record = local.nativeFavoriteSnapshot[0];
    assert.equal('audible' in record, false);
    assert.equal('mutedInfo' in record, false);
});
