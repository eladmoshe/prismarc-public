import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NativeFavorites, getFavoriteDropTarget } from '../../native-favorites.js';
import { SpaceFavorites } from '../../space-favorites.js';

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
        storage: { local: area(local), session: area(session), onChanged: event() },
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
            remove: async id => { tabs = tabs.filter(tab => tab.id !== id); },
            move: async (id, { index }) => {
                const tab = tabs.find(item => item.id === id);
                const pinned = tabs.filter(item => item.pinned && item.windowId === tab.windowId).sort((a, b) => a.index - b.index);
                pinned.splice(pinned.indexOf(tab), 1);
                pinned.splice(index, 0, tab);
                pinned.forEach((item, position) => { item.index = position; });
            },
            onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(), onMoved: event()
        }
    };
});

const scope = { windowId: 1, spaceId: 'home' };
const get = (store, spaceId = 'home', windowId = 1) => store.dispatch({ action: 'get', spaceId, windowId });
const scopedStore = (context = {}) => new SpaceFavorites(async () => ({
    initialSpaceIds: ['home', 'work'], spaceIds: ['home', 'work'], activeSpaceId: 'home', ...context
}));
const idsOf = cards => cards.map(card => card.favoriteId);

test('migrates live and closed native Favorites once into startup Spaces, preserving independent order', async () => {
    const group = 'window-1';
    tabs[0].pinned = true;
    const [live, closed] = tabs;
    local.nativeFavoriteSnapshot = [
        { tabId: live.id, group, index: 0, favoriteId: 'live', baseUrl: live.url, url: live.url, title: live.title },
        { tabId: null, group, index: 1, favoriteId: 'closed', baseUrl: closed.url, url: closed.url,
            title: closed.title, closed: true }
    ];
    session.nativeFavoritesSession = { windowGroups: [[1, group]], restoreQueue: [] };
    const context = { spaceIds: ['home', 'work', 'new'] };
    const store = scopedStore(context);
    assert.deepEqual(idsOf(await get(store)), ['live', 'closed']);
    assert.deepEqual(idsOf(await get(store, 'work')), ['live', 'closed']);
    assert.deepEqual(await get(store, 'new'), []);
    await store.dispatch({ ...scope, action: 'reorder', favoriteIds: ['closed', 'live'] });
    const reloaded = scopedStore(context);
    assert.deepEqual(idsOf(await get(reloaded)), ['closed', 'live']);
    assert.deepEqual(idsOf(await get(reloaded, 'work')), ['live', 'closed']);
    assert.deepEqual(await get(reloaded, 'new'), []);
    assert.equal(tabs.filter(tab => tab.pinned).length, 1);
    await reloaded.dispatch({ ...scope, action: 'remove', favoriteId: 'live' });
    assert.equal(tabs[0].pinned, true);
    await reloaded.dispatch({ ...scope, spaceId: 'work', action: 'remove', favoriteId: 'live' });
    assert.equal(tabs[0].pinned, false);
    assert.deepEqual(idsOf(await get(reloaded)), ['closed']);
    assert.deepEqual(idsOf(await get(reloaded, 'work')), ['closed']);
});

test('adds, copies, opens, and moves Favorites by Space identity even at identical URLs', async () => {
    const store = scopedStore();
    const [home] = await store.dispatch({ ...scope, action: 'pin', tabIds: [1] });
    assert.deepEqual(await get(store, 'work'), []);
    await store.dispatch({ ...scope, action: 'copy', favoriteId: home.favoriteId, targetSpaceId: 'work' });
    const [work] = await get(store, 'work');
    assert.equal(work.baseUrl, home.baseUrl);
    assert.notEqual(work.favoriteId, home.favoriteId);
    assert.equal(work.closed, true);
    await store.dispatch({ ...scope, action: 'copy', favoriteId: home.favoriteId, targetSpaceId: 'work' });
    assert.deepEqual(idsOf(await get(store, 'work')), [work.favoriteId]);
    const [opened] = await store.dispatch({ ...scope, spaceId: 'work', action: 'open', favoriteId: work.favoriteId });
    assert.equal(opened.favoriteId, work.favoriteId);
    assert.notEqual(opened.id, home.id);
    assert.deepEqual(await store.dispatch({ ...scope, action: 'owner', tabId: opened.id }), [{ spaceId: 'work' }]);
    assert.deepEqual(await store.dispatch({ ...scope, action: 'move', favoriteId: home.favoriteId, targetSpaceId: 'work' }), []);
    assert.deepEqual(idsOf(await get(store, 'work')), [work.favoriteId, home.favoriteId]);
    assert.equal(tabs.filter(tab => tab.pinned).length, 2);
});

test('space capacity, active native pinning, closure, and removal remain scoped', async () => {
    const context = { activeSpaceId: 'work' };
    const store = scopedStore(context);
    store.install();
    await store.native.chain;
    const home = await store.dispatch({ ...scope, action: 'pin', tabIds: Array.from({ length: 12 }, (_, i) => i + 1) });
    await assert.rejects(store.dispatch({ ...scope, action: 'pin', tabIds: [13] }), /up to 12/);
    const [work] = await store.dispatch({ ...scope, spaceId: 'work', action: 'pin', tabIds: [13] });
    tabs.at(-1).pinned = true;
    chrome.tabs.onUpdated.emit(16, { pinned: true }, tabs.at(-1));
    await store.native.chain;
    assert.deepEqual((await get(store, 'work')).map(item => item.id), [13, 16]);
    tabs = tabs.filter(tab => tab.id !== 13);
    chrome.tabs.onRemoved.emit(13, { windowId: 1, isWindowClosing: false });
    await store.native.chain;
    assert.equal((await get(store, 'work'))[0].closed, true);
    assert.deepEqual(idsOf(await get(store)), idsOf(home));
    await store.dispatch({ ...scope, spaceId: 'work', action: 'remove', favoriteId: work.favoriteId });
    assert.deepEqual((await get(store, 'work')).map(item => item.id), [16]);
});

test('deleted Space unpins orphan tabs while keeping shared Favorites and the native tabs', async () => {
    tabs[0].pinned = true;
    const context = { spaceIds: ['home', 'work'] };
    const store = scopedStore(context);
    await get(store);
    const first = (await get(store, 'work'))[0].favoriteId;
    await store.dispatch({ ...scope, spaceId: 'work', action: 'pin', tabIds: [2] });
    context.spaceIds = ['home'];
    assert.deepEqual(idsOf(await get(store)), [first]);
    assert.equal(tabs[0].pinned, true);
    assert.equal(tabs[1].pinned, false);
    assert.equal(tabs.length, 16);
    assert.equal(local.spaceFavorites.work, undefined);
});

test('worker wake matches newly visible pins and keeps private memberships only in browser memory', async () => {
    const store = scopedStore();
    await get(store);
    tabs[0].pinned = true; // Native pin discovered while installing event listeners.
    tabs[1].windowId = 2;
    tabs[1].incognito = true;
    tabs[1].url = 'https://private-fixture.test/site';
    const reloaded = scopedStore({ activeSpaceId: 'work' });
    const [work] = await get(reloaded, 'work');
    assert.deepEqual(await get(reloaded), []);
    assert.equal(work.id, 1);
    const [privatePin] = await reloaded.dispatch({ windowId: 2, spaceId: 'home', action: 'pin', tabIds: [2] });
    const nextWorker = scopedStore({ activeSpaceId: 'work' });
    assert.deepEqual(idsOf(await get(nextWorker, 'home', 2)), [privatePin.favoriteId]);
    assert.deepEqual(await get(nextWorker, 'work', 2), []);
    assert.doesNotMatch(JSON.stringify(local), /private-/);
    assert.doesNotMatch(JSON.stringify(session), /private-fixture/);
});

test('scoped close and mute reject stale cards after a move and retain the saved Favorite after close', async () => {
    const store = scopedStore();
    tabs[0].audible = true;
    const [favorite] = await store.dispatch({ ...scope, action: 'pin', tabIds: [1] });
    const selection = { ...scope, favoriteId: favorite.favoriteId, tabId: favorite.id };
    await store.dispatch({ ...selection, action: 'toggleMute' });
    assert.deepEqual(updates.at(-1), [1, { muted: true }]);
    await store.dispatch({ ...selection, action: 'move', targetSpaceId: 'work' });
    await assert.rejects(store.dispatch({ ...selection, action: 'toggleMute' }), /no longer/);
    await assert.rejects(store.dispatch({ ...selection, action: 'close' }), /no longer/);
    await assert.rejects(store.dispatch({ ...selection, spaceId: 'work', tabId: 2, action: 'close' }), /changed/);
    const [closed] = await store.dispatch({ ...selection, spaceId: 'work', action: 'close' });
    assert.equal(closed.favoriteId, favorite.favoriteId);
    assert.equal(closed.closed, true);
    assert.equal(closed.id, null);
    assert.equal(tabs.length, 15);
    assert.equal(local.nativeFavoriteSnapshot[0].audible, undefined);
});

test('a native unpin that wakes the worker removes legacy memberships without unpinning other tabs', async () => {
    const original = scopedStore();
    tabs[0].pinned = true;
    const [legacy] = await get(original);
    assert.deepEqual(idsOf(await get(original, 'work')), [legacy.favoriteId]);
    tabs[0].pinned = false;
    const worker = scopedStore();
    worker.install();
    chrome.tabs.onUpdated.emit(1, { pinned: false }, tabs[0]);
    await worker.native.chain;
    assert.deepEqual(local.spaceFavorites, { home: [], work: [] });
    assert.equal(tabs.length, 16);
});

test('a first close from a legacy version still seeds the saved Favorite into the existing Spaces', async () => {
    const baseUrl = 'https://old.test/saved';
    local.nativeFavoriteSnapshot = [{ tabId: 81, baseUrl, url: 'https://old.test/away', title: 'Saved' }];
    session.nativeFavoritesSession = { restoreQueue: [] };
    chrome.windows = { get: async id => ({ id, type: 'normal', incognito: false }) };
    const store = scopedStore();
    store.install();
    chrome.tabs.onRemoved.emit(81, { windowId: 1, isWindowClosing: false });
    await store.native.chain;
    const [favorite] = await get(store);
    assert.equal(favorite.baseUrl, baseUrl);
    assert.equal(favorite.closed, true);
    assert.deepEqual(idsOf(await get(store, 'work')), [favorite.favoriteId]);
});

test('Space reorder mirrors only its own slots in Chrome and leaves the other Space in order', async () => {
    const store = scopedStore();
    for (const [index, tab] of tabs.slice(0, 4).entries()) {
        await store.dispatch({ ...scope, spaceId: index % 2 ? 'work' : 'home', action: 'pin', tabIds: [tab.id] });
    }
    const home = await get(store);
    const work = await get(store, 'work');
    const favoriteIds = idsOf(home).reverse();
    await store.dispatch({ ...scope, action: 'reorder', favoriteIds });
    assert.deepEqual(idsOf(await get(store)), favoriteIds);
    assert.deepEqual(idsOf(await get(store, 'work')), idsOf(work));
    assert.deepEqual(tabs.filter(tab => tab.pinned).sort((a, b) => a.index - b.index).map(tab => tab.id), [3, 2, 1, 4]);
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
