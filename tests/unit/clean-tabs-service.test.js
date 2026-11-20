import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCleanTabsHandler } from '../../clean-tabs-service.js';

function fixture() {
    const runtime = { id: 'test', getURL: path => 'chrome-extension://test/' + path };
    const sender = { id: runtime.id, url: runtime.getURL('sidebar.html') };
    const tabs = new Map();
    const closed = [];
    const favoriteEvents = [];
    const folder = { id: 'space-folder', parentId: 'arcify' };
    const tree = { ...folder, children: [{ id: 'nested', children: [{ url: 'https://local.test/protected' }] }] };
    let listener;
    const chrome = {
        runtime,
        bookmarks: {
            get: async id => [id === 'arcify' ? { id } : folder],
            getSubTree: async () => [tree],
            onCreated: { addListener: fn => favoriteEvents.push(fn) },
        },
        storage: {
            local: { get: async () => ({ arcifyBookmarkRootId: 'arcify', pinnedTabStatesById: { 6: { bookmarkId: 'saved' } } }) },
            session: { get: async () => ({ openTabFocusTimes: { 3: 300 } }) },
        },
        windows: { get: async id => ({ id, type: 'normal', incognito: false }) },
        tabs: {
            query: async ({ windowId }) => [...tabs.values()].filter(tab => tab.windowId === windowId),
            get: async id => {
                if (!tabs.has(id)) throw new Error('Tab already closed');
                return tabs.get(id);
            },
            remove: async id => closed.push(id),
        },
    };
    globalThis.chrome = chrome;
    const space = { id: 'home', bookmarkFolderId: folder.id, spaceBookmarks: [8], temporaryTabs: [] };
    const store = { spaces: [space], active: { 1: 'home' }, run: operation => Promise.resolve().then(operation) };
    listener = createCleanTabsHandler(chrome, store);
    const tab = (id, overrides = {}) => {
        const result = { id, windowId: 1, index: tabs.size, incognito: false, lastAccessed: 100, url: 'https://local.test/' + id, ...overrides };
        tabs.set(id, result);
        space.temporaryTabs.push(id);
        return result;
    };
    const request = (action, selected, details = {}) => new Promise(resolve => {
        assert.equal(listener({ type: 'cleanTabs', action, spaceId: 'home', windowId: 1, selected, ...details }, sender, resolve), true);
    });
    return { chrome, store, space, tab, tabs, closed, favoriteEvents, request, listener, sender };
}

test('manual preview ranks the least recently viewed tabs first and still includes active and audible tabs', async () => {
    const f = fixture();
    f.tab(1, { active: true, lastAccessed: 200 });
    f.tab(2, { lastAccessed: undefined });
    f.tab(3, { audible: true, lastAccessed: 75 });
    f.tab(4, { pinned: true });
    f.tab(5, { url: 'https://local.test/protected?w=1' });
    f.tab(6);
    f.tab(7, { windowId: 2 });
    f.tab(8);
    f.tab(9, { incognito: true });
    f.tab(10, { pendingUrl: 'https://local.test/protected' });
    f.tab(12, { lastAccessed: 100 });
    f.tab(11, { lastAccessed: 100 });
    f.tab(13, { lastAccessed: 0 });

    assert.deepEqual(await f.request('preview'), {
        success: true, candidates: [
            { id: 11, url: 'https://local.test/11', lastViewed: 100 },
            { id: 12, url: 'https://local.test/12', lastViewed: 100 },
            { id: 1, url: 'https://local.test/1', lastViewed: 200 },
            { id: 3, url: 'https://local.test/3', lastViewed: 300 },
            { id: 2, url: 'https://local.test/2', lastViewed: 0 },
            { id: 13, url: 'https://local.test/13', lastViewed: 0 },
        ],
    });
});

test('apply uses only confirmed IDs and tolerates tab changes and a failed individual removal', async () => {
    const f = fixture();
    for (const id of [1, 2, 3, 4, 5, 7, 9, 10]) f.tab(id);
    const snapshot = (await f.request('preview')).candidates.filter(tab => tab.id !== 10);
    f.tabs.get(2).pinned = true;
    f.tabs.get(3).windowId = 2;
    f.tabs.get(4).url = 'https://local.test/different';
    f.tabs.delete(5);
    f.space.temporaryTabs = f.space.temporaryTabs.filter(id => id !== 7);
    f.tab(11, { lastAccessed: 500 });
    f.chrome.tabs.remove = async id => {
        if (id === 9) throw new Error('Native close failed');
        f.closed.push(id);
    };

    const { undo, ...result } = await f.request('apply', snapshot);
    assert.deepEqual(result, { success: true, closed: 1, remaining: 6 });
    assert.equal(undo.count, 1);
    assert.deepEqual(f.closed, [1]);
});

test('apply fails closed when the space changes or bookmark protection races the final tab read', async () => {
    const f = fixture();
    const tab = f.tab(1);
    f.store.active[1] = 'work';
    assert.deepEqual(await f.request('apply', [tab]), { success: false });
    f.store.active[1] = 'home';
    f.chrome.tabs.get = async () => {
        f.favoriteEvents.forEach(callback => callback());
        return tab;
    };
    assert.deepEqual(await f.request('apply', [tab]), { success: true, closed: 0, remaining: 1 });
    assert.deepEqual(f.closed, []);
});

test('only the extension sidebar can request a cleanup for its window', () => {
    const f = fixture();
    const message = { type: 'cleanTabs', action: 'preview', windowId: 1, spaceId: 'home' };
    const unexpected = () => assert.fail('Rejected request reached the cleanup handler');
    assert.equal(f.listener(message, { ...f.sender, url: 'chrome-extension://test/options.html' }, unexpected), undefined);
    assert.equal(f.listener(message, { ...f.sender, tab: { windowId: 2 } }, unexpected), undefined);
    assert.equal(f.listener(message, { ...f.sender, id: 'other' }, unexpected), undefined);
});

function undoFixture() {
    const f = fixture();
    let sequence = 100;
    const created = [];
    f.chrome.tabs.remove = async id => {
        const removed = f.tabs.get(id);
        f.tabs.delete(id);
        f.space.temporaryTabs = f.space.temporaryTabs.filter(item => item !== id);
        f.closed.push(id);
        const live = await f.chrome.tabs.query({ windowId: removed.windowId });
        for (const existing of live) {
            if (existing.index > removed.index) existing.index--;
        }
        if (removed.active && live.length) live[0].active = true;
    };
    f.chrome.tabs.create = async options => {
        const live = await f.chrome.tabs.query({ windowId: options.windowId });
        const tab = { index: live.length, url: 'chrome://newtab/', ...options, id: sequence++ };
        for (const existing of live) {
            if (existing.index >= tab.index) existing.index++;
        }
        f.tabs.set(tab.id, tab);
        created.push(tab);
        return tab;
    };
    const undo = (result, details) => f.request('undo', undefined, { undoId: result.undo.id, ...details });
    return { ...f, created, undo };
}

test('Undo reopens only the last Clean batch in its original window, space and two independent orders', async () => {
    const f = undoFixture();
    const tabs = [0, 1, 2, 3, 4].map(id => f.tab(id, { active: id === 1 }));
    f.space.temporaryTabs = [2, 3, 4, 0, 1];
    f.store.spaces.push({ id: 'work', temporaryTabs: [], spaceBookmarks: [] });
    const batch = await f.request('apply', [tabs[4], tabs[3], tabs[0]]);
    assert.equal(batch.undo.count, 3);
    f.store.active[1] = 'work';
    assert.deepEqual(await f.undo(batch, { spaceId: 'work' }), { success: true, expired: true });
    assert.deepEqual(await f.undo(batch, { windowId: 2 }), { success: true, expired: true });
    assert.equal(f.created.length, 0);
    const stillOpen = [...f.tabs.values()].sort((a, b) => a.index - b.index);
    stillOpen.forEach((tab, index) => { tab.index = index; });
    assert.deepEqual(await f.undo(batch), { success: true, reopened: 3, remaining: 0 });
    assert.deepEqual(f.space.temporaryTabs.map(id => f.tabs.get(id).url),
        [2, 3, 4, 0, 1].map(id => tabs[id].url));
    assert.deepEqual([...f.tabs.values()].sort((a, b) => a.index - b.index).map(tab => tab.url),
        tabs.map(tab => tab.url));
    assert.deepEqual(f.store.spaces[1].temporaryTabs, []);
    assert.ok(f.created.every(tab => tab.active === false && tab.windowId === 1));
    assert.deepEqual(await f.undo(batch), { success: true, expired: true });
});

test('a partial Undo retries only failed creations and excludes unsafe URLs', async () => {
    const f = undoFixture();
    const selected = [f.tab(1), f.tab(2), f.tab(3, { url: 'chrome://restart/' })];
    f.tab(9, { pinned: true });
    const batch = await f.request('apply', selected);
    assert.equal(batch.closed, 3);
    assert.equal(batch.undo.count, 2);
    const create = f.chrome.tabs.create;
    f.chrome.tabs.create = async options => {
        if (options.url === selected[1].url) throw new Error('Cannot open page');
        return create(options);
    };
    assert.deepEqual(await f.undo(batch), { success: true, reopened: 1, remaining: 1 });
    f.chrome.tabs.create = create;
    assert.deepEqual(await f.undo(batch), { success: true, reopened: 1, remaining: 0 });
    assert.deepEqual(f.created.map(tab => tab.url), selected.slice(0, 2).map(tab => tab.url));
});

test('a successful later clean replaces the older batch, and Undo expires', async t => {
    const f = undoFixture();
    f.tab(9, { pinned: true });
    const first = await f.request('apply', [f.tab(1)]);
    const second = await f.request('apply', [f.tab(2)]);
    assert.deepEqual(await f.undo(first), { success: true, expired: true });
    t.mock.method(Date, 'now', () => second.undo.expiresAt);
    assert.deepEqual(await f.undo(second), { success: true, expired: true });
    assert.equal(f.created.length, 0);
});


test('Clean keeps a window open when it closes its final native tab, and Undo keeps the new tab active', async () => {
    const f = undoFixture();
    const first = f.tab(1, { active: true });
    const second = f.tab(2);
    const apply = await f.request('apply', [second, first]);

    assert.equal(apply.closed, 2);
    assert.equal(apply.undo.count, 2);
    assert.deepEqual(f.closed, [second.id, first.id]);
    assert.equal(f.created.length, 1);
    const [replacement] = f.created;
    assert.equal(replacement.url, 'chrome://newtab/');
    assert.equal(replacement.active, true);
    assert.deepEqual([...f.tabs.keys()], [replacement.id]);

    assert.deepEqual(await f.undo(apply), { success: true, reopened: 2, remaining: 0 });
    assert.equal(replacement.active, true);
    assert.deepEqual(f.created.slice(1).map(tab => tab.active), [false, false]);
    assert.deepEqual(f.space.temporaryTabs.map(id => f.tabs.get(id).url), [first.url, second.url]);
});

test('an earlier failed close keeps the window open without a replacement tab', async () => {
    const f = undoFixture();
    const survivor = f.tab(1, { active: true });
    const second = f.tab(2);
    const remove = f.chrome.tabs.remove;
    f.chrome.tabs.remove = async id => {
        if (id === survivor.id) throw new Error('Native close failed');
        return remove(id);
    };
    const { undo, ...result } = await f.request('apply', [survivor, second]);

    assert.deepEqual(result, { success: true, closed: 1, remaining: 1 });
    assert.equal(undo.count, 1);
    assert.deepEqual(f.created, []);
    assert.deepEqual([...f.tabs.keys()], [survivor.id]);
});

test('a failed final close discards the unused replacement and keeps successful earlier closes undoable', async () => {
    const f = undoFixture();
    const first = f.tab(1);
    const survivor = f.tab(2, { active: true });
    const remove = f.chrome.tabs.remove;
    f.chrome.tabs.remove = async id => {
        if (id === survivor.id) throw new Error('Native close failed');
        return remove(id);
    };
    const apply = await f.request('apply', [first, survivor]);

    assert.equal(apply.closed, 1);
    assert.equal(apply.remaining, 1);
    assert.equal(apply.undo.count, 1);
    assert.equal(f.created.length, 1);
    assert.deepEqual([...f.tabs.keys()], [survivor.id]);
    assert.deepEqual(await f.undo(apply), { success: true, reopened: 1, remaining: 0 });
    assert.deepEqual(f.space.temporaryTabs.map(id => f.tabs.get(id).url), [first.url, survivor.url]);
});

test('a successful Clean with no reopenable address invalidates the previous batch', async () => {
    const f = undoFixture();
    const first = f.tab(1);
    const unsupported = f.tab(2, { url: 'chrome://restart/' });
    f.tab(9, { pinned: true });
    const previous = await f.request('apply', [first]);

    assert.deepEqual(await f.request('apply', [unsupported]), { success: true, closed: 1, remaining: 0 });
    assert.deepEqual(await f.undo(previous), { success: true, expired: true });
});
