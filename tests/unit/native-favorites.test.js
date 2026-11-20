import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NativeFavorites, getFavoriteDropTarget } from '../../native-favorites.js';

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
            create: async options => {
                const tab = { ...options, id: Math.max(0, ...tabs.map(tab => tab.id)) + 1 };
                tabs.push(tab);
                return structuredClone(tab);
            },
            query: async query => structuredClone(tabs.filter(tab =>
                (query.pinned === undefined || tab.pinned === query.pinned) &&
                (query.windowId === undefined || tab.windowId === query.windowId))),
            get: async id => { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Tab closed'); return structuredClone(tab); },
            update: async (id, change) => { updates.push([id, change]); const tab = tabs.find(tab => tab.id === id); Object.assign(tab, change); return structuredClone(tab); },
            onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(), onMoved: event()
        }
    };
});

test('twelve Favorites fit; a thirteenth and an oversized batch leave existing pins unchanged', async () => {
    const store = new NativeFavorites(); store.install(); await store.chain;
    await store.dispatch({ action: 'pin', tabIds: Array.from({ length: 11 }, (_, index) => index + 1) });
    await assert.rejects(store.dispatch({ action: 'pin', tabIds: [12, 13] }), /up to 12/);
    assert.equal(tabs.filter(tab => tab.pinned).length, 11);
    await store.dispatch({ action: 'pin', tabIds: [12, 12] });
    await assert.rejects(store.dispatch({ action: 'pin', tabIds: [13] }), /up to 12/);
    assert.equal(updates.length, 12);
    assert.equal((await store.dispatch({ action: 'get', windowId: 1 })).length, 12);
    tabs.shift();
    chrome.tabs.onRemoved.emit(1, { windowId: 1, isWindowClosing: false }); await store.chain;
    await assert.rejects(store.dispatch({ action: 'pin', tabIds: [13] }), /up to 12/);
    const favorites = await store.dispatch({ action: 'get', windowId: 1 });
    assert.equal(favorites.length, 12);
    assert.equal(favorites.filter(favorite => favorite.closed).length, 1);
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
    assert.deepEqual(await store.dispatch({ action: 'get', windowId: 1 }), []);
    const [repinned] = await store.dispatch({ action: 'pin', tabIds: [44] });
    assert.equal(repinned.baseUrl, tabs[0].url);
    tabs.shift(); chrome.tabs.onRemoved.emit(44, { windowId: 1, isWindowClosing: false }); await store.chain;
    const reloaded = new NativeFavorites();
    const [closed] = await reloaded.dispatch({ action: 'get', windowId: 1 });
    assert.equal(closed.favoriteId, repinned.favoriteId);
    assert.equal(closed.baseUrl, repinned.baseUrl);
    assert.equal(closed.id, null);
    assert.equal(closed.closed, true);
    assert.deepEqual(await reloaded.dispatch({ action: 'get', windowId: 2 }), []);
    const open = { action: 'open', windowId: 1, favoriteId: closed.favoriteId };
    await Promise.all([reloaded.dispatch(open), reloaded.dispatch(open)]);
    const [reopened] = await reloaded.dispatch({ action: 'get', windowId: 1 });
    assert.equal(reopened.favoriteId, repinned.favoriteId);
    assert.equal(tabs.filter(tab => tab.pinned && tab.url === repinned.baseUrl).length, 1);
});

test('window closure keeps reset URLs through worker restart and later restoration', async () => {
    const store = new NativeFavorites(); store.install(); await store.chain;
    const baseUrl = tabs[0].url;
    const [original] = await store.dispatch({ action: 'pin', tabIds: [1] });
    tabs.shift(); chrome.tabs.onRemoved.emit(1, { isWindowClosing: true }); await store.chain;
    const next = new NativeFavorites(); next.install(); await next.chain;
    tabs.push({ id: 44, index: 0, windowId: 2, url: baseUrl, pinned: true });
    // Only the new worker would receive the restored tab event.
    const listener = chrome.tabs.onCreated.listeners.at(-1);
    listener(tabs.at(-1)); await next.chain;
    const [restored] = await next.dispatch({ action: 'get', windowId: 2 });
    assert.equal(restored.favoriteId, original.favoriteId);
    assert.equal(restored.baseUrl, baseUrl);
    assert.equal(next.restoreQueue.length, 0);
});

test('a close that wakes the worker preserves the exact slot, including equal-URL neighbors and a failed reopen', async () => {
    tabs[1].url = tabs[0].url;
    const original = new NativeFavorites();
    const before = await original.dispatch({ action: 'pin', tabIds: [1, 2, 3] });
    const favoriteId = before[1].favoriteId;
    const [closedTab] = tabs.splice(1, 1);
    const worker = new NativeFavorites();
    worker.install();
    // Chrome reports a final unpin while this tab is already absent from live queries.
    // A user-initiated unpin of a surviving tab is covered separately.
    chrome.tabs.onUpdated.emit(2, { pinned: false }, { ...closedTab, pinned: false });
    chrome.tabs.onRemoved.emit(2, { windowId: 1, isWindowClosing: false });
    await worker.chain;
    const after = await worker.dispatch({ action: 'get', windowId: 1 });
    assert.deepEqual(after.map(item => item.favoriteId), before.map(item => item.favoriteId));
    assert.deepEqual(after.map(item => item.id), [1, null, 3]);
    const open = { action: 'open', windowId: 1, favoriteId };
    const create = chrome.tabs.create;
    chrome.tabs.create = async () => { throw new Error('cannot create tab'); };
    await assert.rejects(worker.dispatch(open), /cannot create tab/);
    assert.equal((await worker.dispatch({ action: 'get', windowId: 1 }))[1].closed, true);
    chrome.tabs.create = create;
    const reopened = await worker.dispatch(open);
    assert.deepEqual(reopened.map(item => item.favoriteId), before.map(item => item.favoriteId));
    assert.notEqual(reopened[1].id, 1);
});

test('an existing Favorite from the previous release retains its reset URL after migration and close', async () => {
    const baseUrl = 'https://original.test/old?value=1#saved';
    tabs[0].pinned = true;
    local.nativeFavoriteSnapshot = [{ tabId: 1, title: 'Existing pin', baseUrl, url: tabs[0].url }];
    session.nativeFavoritesSession = { restoreQueue: [] };
    const worker = new NativeFavorites();
    worker.install(); await worker.chain;
    const [live] = await worker.dispatch({ action: 'get', windowId: 1 });
    assert.equal(live.baseUrl, baseUrl);
    assert.ok(live.favoriteId);
    tabs.shift(); chrome.tabs.onRemoved.emit(1, { windowId: 1, isWindowClosing: false }); await worker.chain;
    const [closed] = await new NativeFavorites().dispatch({ action: 'get', windowId: 1 });
    assert.equal(closed.favoriteId, live.favoriteId);
    assert.equal(closed.baseUrl, baseUrl);
});

test('the first close after upgrading a suspended worker recovers a legacy pin only for a regular window', async () => {
    const regular = { tabId: 81, baseUrl: 'https://old.test/start', url: 'https://old.test/away', title: 'Saved' };
    const privatePin = { tabId: 82, baseUrl: 'https://private-fixture.test/start', url: 'https://private-fixture.test/away', title: 'Private' };
    local.nativeFavoriteSnapshot = [regular, privatePin];
    session.nativeFavoritesSession = { restoreQueue: [] };
    chrome.windows = { get: async id => ({ id, type: 'normal', incognito: id === 9 }) };
    const worker = new NativeFavorites();
    worker.install();
    chrome.tabs.onRemoved.emit(regular.tabId, { windowId: 1, isWindowClosing: false });
    chrome.tabs.onRemoved.emit(privatePin.tabId, { windowId: 9, isWindowClosing: false });
    await worker.chain;
    const [saved] = await worker.dispatch({ action: 'get', windowId: 1 });
    assert.equal(saved.closed, true);
    assert.equal(saved.baseUrl, regular.baseUrl);
    assert.deepEqual(await worker.dispatch({ action: 'get', windowId: 9 }), []);
    assert.doesNotMatch(JSON.stringify([local, session]), /private-fixture/);
});

test('late native window restoration exposes closed Favorites only to their original window', async () => {
    tabs = tabs.slice(0, 4);
    tabs[2].windowId = tabs[3].windowId = 2;
    const original = new NativeFavorites();
    original.install(); await original.chain;
    await original.dispatch({ action: 'pin', tabIds: [1, 2, 3, 4] });
    const first = await original.dispatch({ action: 'get', windowId: 1 });
    const second = await original.dispatch({ action: 'get', windowId: 2 });
    for (const tab of [tabs[1], tabs[3]]) {
        tabs = tabs.filter(live => live.id !== tab.id);
        chrome.tabs.onRemoved.emit(tab.id, { windowId: tab.windowId, isWindowClosing: false });
    }
    await original.chain;
    session = {}; chrome.storage.session = area(session);
    // Chrome can restore a first window before reporting the URL of its pin;
    // an unrelated second window and its anchor arrive later with new native IDs.
    tabs = [{ id: 42, index: 0, windowId: 92, pinned: true }];
    const restored = new NativeFavorites();
    restored.install(); await restored.chain;
    assert.deepEqual(await restored.dispatch({ action: 'get', windowId: 92 }), []);
    tabs[0].url = second[0].url;
    chrome.tabs.onUpdated.listeners.at(-1)(42, { url: tabs[0].url }, tabs[0]);
    await restored.chain;
    tabs.push({ id: 41, index: 0, windowId: 91, pinned: true, url: first[0].url });
    chrome.tabs.onCreated.listeners.at(-1)(tabs[1]); await restored.chain;
    const firstRestored = await restored.dispatch({ action: 'get', windowId: 91 });
    const secondRestored = await restored.dispatch({ action: 'get', windowId: 92 });
    assert.deepEqual(firstRestored.map(item => item.favoriteId), first.map(item => item.favoriteId));
    assert.deepEqual(secondRestored.map(item => item.favoriteId), second.map(item => item.favoriteId));
    assert.equal(firstRestored[1].closed, true);
    assert.equal(secondRestored[1].closed, true);
    await assert.rejects(restored.dispatch({ action: 'open', windowId: 92, favoriteId: first[1].favoriteId }));
});

test('an Incognito favorite never persists its private address on pin, navigation or close', async () => {
    tabs[0].incognito = true;
    tabs[0].windowId = 9;
    tabs[0].url = 'https://private-fixture.test/pin';
    const worker = new NativeFavorites();
    worker.install(); await worker.chain;
    await worker.dispatch({ action: 'pin', tabIds: [1] });
    assert.equal((await worker.dispatch({ action: 'get', windowId: 9 }))[0].id, 1);
    tabs[0].url = 'https://private-fixture.test/elsewhere';
    chrome.tabs.onUpdated.emit(1, { url: tabs[0].url }, tabs[0]); await worker.chain;
    assert.doesNotMatch(JSON.stringify([local, session]), /private-fixture/);
    tabs.shift(); chrome.tabs.onRemoved.emit(1, { windowId: 9, isWindowClosing: false }); await worker.chain;
    assert.deepEqual(await worker.dispatch({ action: 'get', windowId: 9 }), []);
    assert.doesNotMatch(JSON.stringify([local, session]), /private-fixture/);
});

test('a closed-only Favorite survives a one-window restart and explicit removal survives a worker restart', async () => {
    const initial = new NativeFavorites();
    initial.install(); await initial.chain;
    const [favorite] = await initial.dispatch({ action: 'pin', tabIds: [1] });
    tabs.shift(); chrome.tabs.onRemoved.emit(1, { windowId: 1, isWindowClosing: false }); await initial.chain;
    session = {}; chrome.storage.session = area(session);
    tabs = [{ id: 42, index: 0, windowId: 2, pinned: false, url: 'about:blank' }];
    const restarted = new NativeFavorites();
    const [closed] = await restarted.dispatch({ action: 'get', windowId: 2 });
    assert.equal(closed.favoriteId, favorite.favoriteId);
    assert.equal(closed.closed, true);
    await restarted.dispatch({ action: 'remove', windowId: 2, favoriteId: favorite.favoriteId });
    assert.deepEqual(await new NativeFavorites().dispatch({ action: 'get', windowId: 2 }), []);
    assert.equal(tabs.length, 1);
});

test('moving a closed Favorite keeps native tabs in place and removing it preserves neighboring slots', async () => {
    const worker = new NativeFavorites();
    worker.install(); await worker.chain;
    const [a, b, c, d] = await worker.dispatch({ action: 'pin', tabIds: [1, 2, 3, 4] });
    for (const id of [2, 3]) {
        tabs = tabs.filter(tab => tab.id !== id);
        tabs.forEach((tab, index) => { tab.index = index; });
        chrome.tabs.onRemoved.emit(id, { windowId: 1, isWindowClosing: false }); await worker.chain;
    }
    const order = [b, a, c, d].map(tab => tab.favoriteId);
    const moved = await worker.dispatch({ action: 'reorder', windowId: 1, favoriteIds: order });
    assert.deepEqual(moved.map(tab => tab.favoriteId), order);
    assert.deepEqual(moved.map(tab => tab.id), [null, 1, null, 4]);
    const remaining = await worker.dispatch({ action: 'remove', windowId: 1, favoriteId: b.favoriteId });
    assert.deepEqual(remaining.map(tab => tab.favoriteId), [a, c, d].map(tab => tab.favoriteId));
    assert.deepEqual(tabs.filter(tab => tab.pinned).map(tab => tab.id), [1, 4]);
});

test('native reordering immediately before close retains the new position without a sidebar', async () => {
    const worker = new NativeFavorites();
    worker.install(); await worker.chain;
    const [a, b, c] = await worker.dispatch({ action: 'pin', tabIds: [1, 2, 3] });
    chrome.tabs.onMoved.emit(3, { windowId: 1, fromIndex: 2, toIndex: 0 });
    tabs = tabs.filter(tab => tab.id !== 3);
    chrome.tabs.onRemoved.emit(3, { windowId: 1, isWindowClosing: false });
    await worker.chain;
    const after = await worker.dispatch({ action: 'get', windowId: 1 });
    assert.deepEqual(after.map(favorite => favorite.favoriteId), [c, a, b].map(favorite => favorite.favoriteId));
    assert.deepEqual(after.map(favorite => favorite.id), [null, 1, 2]);
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
