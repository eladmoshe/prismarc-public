import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerCleanTabs } from '../../clean-tabs-service.js';

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
        runtime: { ...runtime, onMessage: { addListener: fn => { listener = fn; } } },
        bookmarks: {
            get: async () => [folder],
            search: async () => [{ id: 'arcify' }],
            getSubTree: async () => [tree],
            onCreated: { addListener: fn => favoriteEvents.push(fn) },
        },
        storage: {
            local: { get: async () => ({ pinnedTabStatesById: { 6: { bookmarkId: 'saved' } } }) },
            session: { get: async () => ({ openTabFocusTimes: { 3: 300 } }) },
        },
        windows: { get: async id => ({ id, type: 'normal', incognito: false }) },
        tabs: {
            query: async () => [...tabs.values()],
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
    registerCleanTabs(chrome, store);
    const tab = (id, overrides = {}) => {
        const result = { id, windowId: 1, incognito: false, lastAccessed: 100, url: 'https://local.test/' + id, ...overrides };
        tabs.set(id, result);
        space.temporaryTabs.push(id);
        return result;
    };
    const request = (action, selected) => new Promise(resolve => {
        assert.equal(listener({ type: 'cleanTabs', action, spaceId: 'home', windowId: 1, selected }, sender, resolve), true);
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

    assert.deepEqual(await f.request('apply', snapshot), { success: true, closed: 1, remaining: 6 });
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
