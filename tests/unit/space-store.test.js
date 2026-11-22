import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SpaceStore, applySpacePatch, ownerOf } from '../../space-store.js';
import { syncSpaceGroups } from '../../tab-group-sync.js';
import { DEFAULT_SPACE_COLOR, LIGHT_SPACE_COLOR } from '../../space-colors.js';
import { Utils } from '../../utils.js';
import { restoreLifetime } from '../../space-restore.js';

let local, session, tabs, mutations, groups;
const area = data => ({
    async get(keys) {
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
        return Object.fromEntries(names.map(k => [k, structuredClone(data[k] ?? keys?.[k])]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); }
});
const space = (id, ids = []) => ({ id, spaceUuid: id, name: id, color: 'blue', bookmarkFolderId: id, spaceBookmarks: [], temporaryTabs: ids });
beforeEach(() => {
    local = { spaceModelVersion: 2, spaces: [space('a', [1]), space('b', [2])], arcifyBookmarkRootId: 'root' };
    session = { spaceSession: true }; mutations = []; groups = [];
    tabs = [{ id: 1, windowId: 1, index: 0, url: 'https://one.test/', groupId: -1 },
        { id: 2, windowId: 1, index: 1, url: 'https://two.test/', groupId: -1 }];
    const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
    globalThis.chrome = {
        runtime: { getURL: path => `chrome-extension://arcify/${path}` },
        storage: { local: area(local), session: area(session), onChanged: event() },
        tabs: { onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(), onActivated: event(), onMoved: event(), query: async query => tabs.filter(t => query.groupId === undefined || query.groupId === t.groupId),
            get: async id => {
                const tab = tabs.find(tab => tab.id === id);
                if (!tab) throw new Error(`No tab with id: ${id}.`);
                return structuredClone(tab);
            },
            group: async args => { mutations.push(['group', args]); const id = args.groupId ?? 100 + groups.length; if (!groups.some(g => g.id === id)) groups.push({ id, windowId: 1 }); tabs.filter(t => args.tabIds.includes(t.id)).forEach(t => t.groupId = id); return id; },
            move: async (...args) => mutations.push(['move', ...args]) },
        tabGroups: { onRemoved: event(), onUpdated: event(), query: async () => groups, update: async (id, attrs) => { mutations.push(['update', id, attrs]); Object.assign(groups.find(g => g.id === id), attrs); } },
        bookmarks: { search: async () => [{ id: 'root' }], get: async id => id === 'root' ? [{ id, title: 'Arcify' }] : [],
            getChildren: async () => [], create: async ({ title }) => ({ id: title, title }) }
    };
});

test('Air Traffic settings are ordered, validated, persisted, and protected from stale edits', async () => {
    const store = new SpaceStore();
    const rules = [{ pattern: ' one.test/* ', spaceId: 'b' }, { pattern: 'two.test/example', spaceId: 'a' }];
    assert.deepEqual(await store.airTraffic({ action: 'get' }), []);
    const saved = await store.airTraffic({ action: 'set', rules, expectedRules: [] });
    assert.deepEqual(saved, [{ ...rules[0], pattern: 'one.test/*' }, rules[1]]);
    assert.deepEqual(await new SpaceStore().airTraffic({ action: 'get' }), saved);
    await assert.rejects(store.airTraffic({ action: 'set', rules: [], expectedRules: [saved[1], saved[0]] }),
        { code: 'air_traffic_conflict' });
    await assert.rejects(store.airTraffic({ action: 'set', rules: [{ pattern: 'https://', spaceId: 'a' }] }), /valid URL pattern/);
    await assert.rejects(store.airTraffic({ action: 'set', rules: [{ pattern: 'one.test', spaceId: 'removed' }] }), /no longer available/);
    assert.deepEqual(local.airTrafficRules, saved);
    assert.equal(ownerOf(local.spaces, 1).id, 'a');
});

test('an established profile can save Air Traffic rules before bookmark discovery succeeds', async () => {
    const store = new SpaceStore();
    const readChildren = chrome.bookmarks.getChildren;
    const original = [{ pattern: 'one.test', spaceId: 'a' }];
    const edited = [{ pattern: 'one.test', spaceId: 'b' }];
    local.airTrafficRules = structuredClone(original);
    chrome.bookmarks.getChildren = async () => { throw new Error('Bookmark model unavailable'); };

    await assert.rejects(store.dispatch({ action: 'get' }), { code: 'bookmark_folder_unavailable' });
    assert.deepEqual(await store.airTraffic({ action: 'get' }), original);
    const [first, stale] = await Promise.allSettled([
        store.airTraffic({ action: 'set', rules: edited, expectedRules: original }),
        store.airTraffic({ action: 'set', rules: [], expectedRules: original })
    ]);
    assert.deepEqual(first, { status: 'fulfilled', value: edited });
    assert.equal(stale.reason?.code, 'air_traffic_conflict');

    chrome.bookmarks.getChildren = readChildren;
    const fresh = new SpaceStore();
    await fresh.dispatch({ action: 'get' });
    assert.equal(fresh.airTrafficRules[0].spaceId, 'b');
});

test('Air Traffic cannot overwrite rules it could not read', async () => {
    const store = new SpaceStore();
    const original = [{ pattern: 'one.test', spaceId: 'a' }];
    local.airTrafficRules = structuredClone(original);
    const readLocal = chrome.storage.local.get;
    chrome.storage.local.get = async () => { throw new Error('Temporary read failure'); };
    await assert.rejects(store.airTraffic({ action: 'set', rules: [], expectedRules: [] }),
        { code: 'space_storage_unavailable' });
    assert.deepEqual(local.airTrafficRules, original);

    chrome.storage.local.get = readLocal;
    const malformed = [...original, { spaceId: 'a' }];
    local.airTrafficRules = structuredClone(malformed);
    await assert.rejects(store.airTraffic({ action: 'get' }), /rules could not be read/);
    await assert.rejects(store.airTraffic({ action: 'set', rules: [], expectedRules: original }), /rules could not be read/);
    assert.deepEqual(local.airTrafficRules, malformed);
});

test('Air Traffic follows new committed URLs and preserves the selected Space for background tabs', async () => {
    session.activeSpaces = { 1: 'a' };
    tabs[0].active = true;
    local.spaces[0].lastTab = 1;
    const store = new SpaceStore();
    store.install();
    await store.airTraffic({ action: 'set', rules: [{ pattern: 'one.test/*', spaceId: 'b' }] });
    assert.equal(ownerOf(local.spaces, 1).id, 'a'); // No sweep on rule edits.

    const background = { id: 3, windowId: 1, openerTabId: 1, url: 'https://one.test/background' };
    tabs.push(background);
    chrome.tabs.onCreated.emit(background);
    await store.run(() => store.persist());
    assert.equal(ownerOf(local.spaces, 3).id, 'b');
    assert.equal(session.activeSpaces[1], 'a');

    tabs[0].url = 'https://one.test/foreground';
    chrome.tabs.onUpdated.emit(1, { url: tabs[0].url }, tabs[0]);
    await store.run(() => store.persist());
    assert.deepEqual(local.spaces.map(space => space.temporaryTabs), [[], [2, 3, 1]]);
    assert.equal(local.spaces[0].lastTab, undefined);
    assert.equal(local.spaces[1].lastTab, 1);
    assert.equal(session.activeSpaces[1], 'b');

    tabs[0].url = 'https://other.test/';
    chrome.tabs.onUpdated.emit(1, { url: tabs[0].url }, tabs[0]);
    await store.run(() => store.persist());
    assert.equal(ownerOf(local.spaces, 1).id, 'b');
    assert.deepEqual(mutations, []);
});

test('Air Traffic keeps Space pins, native Favorites, and private tabs out of routing', async () => {
    local.spaces[0].spaceBookmarks = [1];
    local.spaces[0].temporaryTabs = [3];
    tabs[1].pinned = true;
    tabs.push({ id: 3, windowId: 2, incognito: true, url: 'https://one.test/' });
    const store = new SpaceStore();
    store.install();
    await store.airTraffic({ action: 'set', rules: [{ pattern: 'one.test/*', spaceId: 'b' }] });

    for (const tab of tabs) {
        tab.url = 'https://one.test/subpage';
        chrome.tabs.onUpdated.emit(tab.id, { url: tab.url }, tab);
    }
    await store.run(() => store.persist());
    assert.deepEqual(local.spaces[0].spaceBookmarks, [1]);
    assert.deepEqual(local.spaces[0].temporaryTabs, [3]);
    assert.deepEqual(local.spaces[1].temporaryTabs, []);
    assert.equal(ownerOf(local.spaces, 2), undefined);
});

test('Air Traffic skips a stale committed URL and a tab that closes while the lookup is queued', async () => {
    session.activeSpaces = { 1: 'a' };
    const store = new SpaceStore();
    store.install();
    await store.airTraffic({ action: 'set', rules: [{ pattern: 'one.test/*', spaceId: 'b' }] });

    tabs[0].url = 'https://other.test/latest';
    chrome.tabs.onUpdated.emit(1, { url: 'https://one.test/stale' }, { ...tabs[0], url: 'https://one.test/stale' });
    await store.run(() => store.persist());
    assert.equal(ownerOf(local.spaces, 1).id, 'a');

    tabs[0].url = 'https://one.test/close';
    tabs[0].active = true;
    const nativeGet = chrome.tabs.get;
    const reached = Promise.withResolvers();
    const resume = Promise.withResolvers();
    chrome.tabs.get = async id => {
        reached.resolve();
        await resume.promise;
        return nativeGet(id);
    };
    chrome.tabs.onUpdated.emit(1, { url: tabs[0].url }, tabs[0]);
    await reached.promise;
    tabs = tabs.filter(tab => tab.id !== 1);
    chrome.tabs.onRemoved.emit(1, { windowId: 1, isWindowClosing: false });
    resume.resolve();
    await store.run(() => store.persist());
    assert.equal(ownerOf(local.spaces, 1), undefined);
    assert.equal(session.activeSpaces[1], 'a');
    assert.equal(local.spaces[1].lastTab, undefined);
});

test('Air Traffic routes a replacement tab after a native prerender swap', async () => {
    const store = new SpaceStore();
    store.install();
    await store.airTraffic({ action: 'set', rules: [{ pattern: 'one.test/*', spaceId: 'b' }] });
    tabs[0] = { ...tabs[0], id: 9, url: 'https://one.test/prerender' };
    chrome.tabs.onReplaced.emit(9, 1);
    await store.run(() => store.persist());
    assert.equal(ownerOf(local.spaces, 1), undefined);
    assert.equal(ownerOf(local.spaces, 9).id, 'b');
});
test('independent default ignores group identity and order and retains empty spaces', async () => {
    tabs[0].groupId = 99; tabs.reverse();
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    assert.equal(ownerOf(store.spaces, 1).id, 'a');
    tabs = tabs.filter(t => t.id !== 1);
    await store.dispatch({ action: 'activate', spaceId: 'a', windowId: 1 });
    assert.deepEqual(local.spaces[0].temporaryTabs, []);
    assert.equal(local.spaces[0].id, 'a');
    assert.deepEqual(mutations, []);
});
test('new Home and discovered bookmark spaces default to PrismArc', async () => {
    local.spaces = [];
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    assert.equal(local.spaces[0].name, 'Home');
    assert.equal(local.spaces[0].color, DEFAULT_SPACE_COLOR);
    const folder = { id: 'new-folder', title: 'Projects' };
    chrome.bookmarks.getChildren = async () => [folder];
    await store.dispatch({ action: 'get' });
    assert.equal(local.spaces.find(space => space.bookmarkFolderId === folder.id).color, DEFAULT_SPACE_COLOR);
    assert.equal(local.spaceRegistry[folder.id].color, DEFAULT_SPACE_COLOR);
});

test('existing colors and recovered folder colors survive new defaults', async () => {
    delete local.spaces[1].color;
    local.spaceRegistry = {
        a: { spaceUuid: 'a', color: 'grey' },
        b: { spaceUuid: 'b', color: 'pink' },
        c: { spaceUuid: 'c', color: 'yellow' },
    };
    chrome.bookmarks.getChildren = async () => [
        { id: 'a', title: 'a' }, { id: 'b', title: 'b' }, { id: 'c', title: 'c' },
    ];
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    assert.deepEqual(local.spaces.map(space => space.color), ['blue', 'pink', 'yellow']);
    assert.equal(local.spaceRegistry.a.color, 'blue');
    const before = structuredClone(local.spaces);
    const after = structuredClone(before);
    after[1].color = DEFAULT_SPACE_COLOR;
    await store.dispatch({ action: 'patch', before, after });
    assert.equal(local.spaces[1].color, DEFAULT_SPACE_COLOR);
    assert.equal(local.spaceRegistry.b.color, DEFAULT_SPACE_COLOR);
});

test('appearance migrates from the active window once and persists independently of space and worker', async () => {
    local.spaces[1].color = LIGHT_SPACE_COLOR;
    session.activeSpaces = { 1: 'a', 2: 'b' };
    session.lastActiveSpaceId = 'a';
    const store = new SpaceStore();
    const get = windowId => ({ action: 'get', windowId });
    assert.equal(await store.appearanceTheme(get(2)), 'light');
    assert.equal(local.appearanceTheme, 'light');
    assert.equal(await store.appearanceTheme(get(1)), 'light');
    assert.equal(await new SpaceStore().appearanceTheme(get(1)), 'light');
    assert.deepEqual(local.spaces.map(item => item.color), ['blue', LIGHT_SPACE_COLOR]);
});

test('opening Settings first migrates from the last active space and named colors default to dark', async () => {
    local.spaces[1].color = LIGHT_SPACE_COLOR;
    local.lastActiveSpaceId = 'b';
    const store = new SpaceStore();
    assert.equal(await store.appearanceTheme({ action: 'get' }), 'light');
    delete local.appearanceTheme;
    local.spaces[1].color = 'yellow';
    assert.equal(await new SpaceStore().appearanceTheme({ action: 'get' }), 'dark');
});

test('explicit appearance survives competing migration, validates choices, and works without bookmarks', async () => {
    local.spaces[0].color = LIGHT_SPACE_COLOR;
    const store = new SpaceStore();
    const get = { action: 'get' };
    const setDark = { action: 'set', theme: 'dark' };
    const values = await Promise.all([store.appearanceTheme(get), store.appearanceTheme(setDark), store.appearanceTheme(get)]);
    assert.deepEqual(values, ['light', 'dark', 'dark']);
    await assert.rejects(store.appearanceTheme({ action: 'set', theme: 'yellow' }));
    assert.equal(local.appearanceTheme, 'dark');
    chrome.bookmarks.getChildren = async () => { throw new Error('Unavailable'); };
    const next = new SpaceStore();
    await next.appearanceTheme({ action: 'set', theme: 'light' });
    assert.equal(await next.appearanceTheme(get), 'light');
});

test('stale panel patch preserves concurrent tabs, moves and metadata', () => {
    const before = [space('a', [1]), space('b', [2])];
    const current = structuredClone(before); current[0].temporaryTabs.push(3); current[1].color = 'red';
    const after = structuredClone(before); after[0].temporaryTabs = []; after[1].temporaryTabs.push(1);
    const result = applySpacePatch(current, before, after);
    assert.deepEqual(result[0].temporaryTabs, [3]);
    assert.deepEqual(result[1].temporaryTabs, [2, 1]);
    assert.equal(result[1].color, 'red');
});
for (const [defaultName, protectedId] of [['b', 'b'], ['missing', 'a']]) {
    test(`a panel patch cannot remove the main space when the configured default is ${defaultName}`, async () => {
        local.defaultSpaceName = defaultName;
        const store = new SpaceStore();
        const before = await store.dispatch({ action: 'get' });
        const after = before.filter(space => space.id !== protectedId);
        await assert.rejects(store.dispatch({ action: 'patch', before, after }), { code: 'default_space_protected' });
        assert.deepEqual(store.spaces, before);
        assert.deepEqual(local.spaces, before);
    });
}
test('restart remaps URLs to new IDs and retains stored order', async () => {
    session.spaceSession = false;
    local.spaceTabSnapshot = [
        { spaceId: 'a', section: 'temporaryTabs', order: 0, url: 'https://two.test/' },
        { spaceId: 'a', section: 'temporaryTabs', order: 1, url: 'https://one.test/' }
    ];
    tabs = [{ id: 9, windowId: 1, url: 'https://one.test/' }, { id: 8, windowId: 1, url: 'https://two.test/' }, { id: 2, windowId: 1, url: 'https://unrelated.test/' }];
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    assert.deepEqual(store.spaces[0].temporaryTabs, [8, 9, 2]);
    assert.deepEqual(store.spaces[1].temporaryTabs, []);
});
test('worker restart preserves session membership and opener determines new tab space', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    const child = { id: 3, windowId: 1, openerTabId: 2, url: 'https://child.test/' }; tabs.push(child);
    await store.run(async () => { store.track(child); await store.persist(); });
    const next = new SpaceStore(); await next.dispatch({ action: 'get' });
    assert.deepEqual(next.spaces[1].temporaryTabs, [2, 3]);
});
test('external links without an opener use the last selected space in a new window', async () => {
    const store = new SpaceStore();
    await store.dispatch({ action: 'activate', spaceId: 'b', windowId: 1 });
    const external = { id: 3, windowId: 2, url: 'https://external.test/' };
    tabs.push(external);
    await store.run(async () => { store.track(external); await store.persist(); });
    assert.equal(ownerOf(local.spaces, 3).id, 'b');
    assert.equal(session.lastActiveSpaceId, 'b');
    assert.equal(local.lastActiveSpaceId, 'b');
});
test('external links use the durable last selected space after a browser restart', async () => {
    session.spaceSession = false;
    local.lastActiveSpaceId = 'b';
    local.spaceTabSnapshot = [
        { spaceId: 'a', section: 'temporaryTabs', order: 0, url: 'https://one.test/' },
        { spaceId: 'b', section: 'temporaryTabs', order: 0, url: 'https://two.test/' }
    ];
    const external = { id: 3, windowId: 1, active: true, url: 'https://external.test/' };
    tabs.push(external);
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    assert.equal(ownerOf(local.spaces, 3).id, 'b');
});
test('ordinary links still follow their opener instead of the last selected space', async () => {
    const store = new SpaceStore();
    await store.dispatch({ action: 'activate', spaceId: 'b', windowId: 1 });
    const child = { id: 3, windowId: 1, openerTabId: 1, url: 'https://linked.test/' };
    tabs.push(child);
    await store.run(async () => { store.track(child); await store.persist(); });
    assert.equal(ownerOf(local.spaces, 3).id, 'a');
});
test('explicit assignment beats creation fallback', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    await store.dispatch({ action: 'assign', tabId: 1, spaceId: 'b', pinned: true });
    assert.deepEqual(local.spaces[0].temporaryTabs, []);
    assert.deepEqual(local.spaces[1].spaceBookmarks, [1]);
});
test('sync is opt-in and disabling it performs no mutations', async () => {
    await syncSpaceGroups(local.spaces); assert.deepEqual(mutations, []);
    local.syncTabGroups = true; await syncSpaceGroups(local.spaces);
    assert.equal(mutations.filter(m => m[0] === 'group').length, 2);
    assert.deepEqual(local.spaces.map(s => s.id), ['a', 'b']);
    mutations.length = 0; local.syncTabGroups = false;
    await syncSpaceGroups(local.spaces); assert.deepEqual(mutations, []);
});
test('PrismArc presets project to native grey and blue while retaining their saved colors', async () => {
    local.syncTabGroups = true;
    local.spaces[0].color = DEFAULT_SPACE_COLOR;
    local.spaces[1].color = LIGHT_SPACE_COLOR;
    await syncSpaceGroups(local.spaces);
    assert.equal(groups[0].color, 'grey');
    assert.equal(groups[1].color, 'blue');
    assert.equal(local.spaces[0].color, DEFAULT_SPACE_COLOR);
    assert.equal(local.spaces[1].color, LIGHT_SPACE_COLOR);
    mutations.length = 0;
    await syncSpaceGroups(local.spaces);
    assert.deepEqual(mutations, []);
});

test('sync creates each group in its tabs original window', async () => {
    tabs[1].windowId = 2;
    local.syncTabGroups = true;
    await syncSpaceGroups(local.spaces);
    assert.deepEqual(mutations.filter(m => m[0] === 'group').map(m => m[1]), [
        { tabIds: [1], createProperties: { windowId: 1 } },
        { tabIds: [2], createProperties: { windowId: 2 } }
    ]);
});
test('legacy membership and archived IDs migrate once without group writes', async () => {
    delete local.spaceModelVersion;
    local.spaces = [space(42, [1])]; local.spaces[0].name = 'Work';
    local.archivedTabs = [{ url: 'https://archive.test', spaceId: 42 }];
    tabs[0].groupId = 42;
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    assert.equal(typeof local.spaces[0].id, 'string');
    assert.equal(local.archivedTabs[0].spaceId, local.spaces[0].id);
    assert.equal(ownerOf(local.spaces, 1).id, local.spaces[0].id);
    assert.deepEqual(mutations, []);
});
test('optional import copies groups without changing them', async () => {
    groups = [{ id: 42, title: 'Imported', color: 'green', windowId: 1 }]; tabs[1].groupId = 42;
    const store = new SpaceStore(); await store.dispatch({ action: 'import', windowId: 1 });
    assert.equal(ownerOf(local.spaces, 2).name, 'Imported');
    assert.equal(ownerOf(local.spaces, 2).color, 'green');
    assert.equal(local.tabGroupImportDismissed, true);
    assert.deepEqual(mutations, []);
});
test('late restored URL is assigned after an initially blank tab resolves', async () => {
    session.spaceSession = false;
    local.spaceTabSnapshot = [{ spaceId: 'b', section: 'temporaryTabs', order: 0, url: 'https://late.test/' }];
    tabs = [{ id: 10, windowId: 1 }];
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    tabs[0].url = 'https://late.test/';
    await store.run(async () => { store.track(tabs[0]); await store.persist(); });
    assert.equal(ownerOf(local.spaces, 10).id, 'b');
});
test('native pinning removes a space binding even when the sidebar is closed', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    tabs[0].pinned = true;
    await store.run(async () => { store.track(tabs[0]); await store.persist(); });
    assert.equal(ownerOf(local.spaces, 1), undefined);
    tabs[0].pinned = false;
    await store.run(async () => { store.track(tabs[0]); await store.persist(); });
    assert.equal(ownerOf(local.spaces, 1).id, 'a');
});
test('background event handlers track tab replacement and preserve window-close restore records', async () => {
    const store = new SpaceStore(); store.install(); await store.run(() => {});
    tabs[0].id = 11;
    chrome.tabs.onReplaced.emit(11, 1); await store.run(() => {});
    assert.equal(ownerOf(store.spaces, 11).id, 'a');
    tabs = tabs.filter(t => t.id !== 11);
    chrome.tabs.onRemoved.emit(11, { isWindowClosing: true }); await store.run(() => store.persist());
    assert.equal(local.spaces[0].temporaryTabs.length, 0);
    assert.equal(local.spaceTabSnapshot.some(t => t.url === 'https://one.test/'), false);
    assert.equal(session.spaceRestoreQueue.find(t => t.url === 'https://one.test/').spaceId, 'a');
});
test('extension pages are removed when a blank helper tab finishes navigating', async () => {
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    tabs[0].url = 'chrome-extension://arcify/options.html';
    await store.run(async () => { store.track(tabs[0]); await store.persist(); });
    assert.equal(ownerOf(local.spaces, 1), undefined);
});
test('migration recovers legacy groups whose IDs changed before the upgrade', async () => {
    delete local.spaceModelVersion;
    local.spaces = [space(42, [1])]; local.spaces[0].name = 'Work';
    local.spaces.push({ ...space(88, []), name: 'Home' });
    groups = [{ id: 77, title: 'Work', color: 'blue', windowId: 1 }, { id: 42, title: 'Unrelated', color: 'red', windowId: 1 }];
    tabs[0].groupId = 77;
    tabs[1].groupId = 42;
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    assert.equal(ownerOf(local.spaces, 1).name, 'Work');
    assert.equal(ownerOf(local.spaces, 2).name, 'Home');
    assert.deepEqual(mutations, []);
});
test('restart restores bookmark bindings even after navigation away from the pinned URL', async () => {
    session.spaceSession = false;
    local.pinnedTabStatesById = { 1: { bookmarkId: 'old-wrong' } };
    local.spaceTabSnapshot = [{ spaceId: 'b', section: 'spaceBookmarks', order: 0,
        url: 'https://navigated.test/', pinnedState: { bookmarkId: 'favorite', pinnedUrl: 'https://original.test/' } }];
    tabs = [{ id: 12, windowId: 1, url: 'https://navigated.test/' }];
    const store = new SpaceStore(); await store.dispatch({ action: 'get' });
    assert.deepEqual(local.spaces[1].spaceBookmarks, [12]);
    assert.equal(local.pinnedTabStatesById[12].bookmarkId, 'favorite');
    assert.equal(local.pinnedTabStatesById[1], undefined);
});
test('ordinary new-tab pages use the selected space even with an incidental opener', async () => {
    const store = new SpaceStore();
    await store.dispatch({ action: 'activate', spaceId: 'b', windowId: 1 });
    const tab = { id: 3, windowId: 1, openerTabId: 1, url: 'chrome://newtab/' };
    tabs.push(tab);
    await store.run(async () => { store.track(tab); await store.persist(); });
    assert.equal(ownerOf(local.spaces, 3).id, 'b');
});
test('manual archive records the stored owner without a sidebar global', async () => {
    const removed = [];
    chrome.tabs.get = async id => ({ ...tabs.find(t => t.id === id), title: 'Archived example' });
    chrome.tabs.remove = async id => removed.push(id);
    chrome.runtime.sendMessage = async () => ({ success: true, spaces: local.spaces });
    await Utils.archiveTab(2);
    assert.equal(local.archivedTabs[0].spaceId, 'b');
    assert.equal(local.archivedTabs[0].url, 'https://two.test/');
    assert.deepEqual(removed, [2]);
});
test('explicit tab focus raises the window returned by Chrome', async () => {
    const actions = [];
    chrome.tabs.update = async (id, update) => { actions.push(['tab', id, update]); return { id, windowId: 22 }; };
    chrome.windows = { update: async (id, update) => actions.push(['window', id, update]) };
    await Utils.focusTab(2);
    assert.deepEqual(actions, [['tab', 2, { active: true }], ['window', 22, { focused: true }]]);
});
test('version-2 startup discovers Arcify bookmark spaces with group sync off', async () => {
    local.spaces = [];
    local.spaceRegistry = { project: { spaceUuid: 'saved-project', color: 'purple', bookmarkFolderId: 'project' } };
    const tree = { root: [{ id: 'project', title: 'Project' }, { id: 'loose', title: 'Not a space', url: 'https://loose.test/' }], project: [{ id: 'saved-link', title: 'Saved', url: 'https://saved.test/' }, { id: 'nested', title: 'Reading' }], nested: [] };
    chrome.bookmarks.getChildren = async id => structuredClone(tree[id] || []);
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    assert.equal(store.spaces.length, 1);
    assert.equal(store.spaces[0].id, 'saved-project');
    assert.equal(store.spaces[0].bookmarkFolderId, 'project');
    assert.equal(store.spaces[0].color, 'purple');
    await store.dispatch({ action: 'get' });
    assert.equal(store.spaces.length, 1);
    assert.deepEqual(mutations, []);
    assert.equal(tree.project[0].id, 'saved-link');
});
test('sidebar reads discover later bookmark folders and follow folder renames by ID', async () => {
    let folders = [{ id: 'a', title: 'Renamed' }, { id: 'b', title: 'b' }];
    chrome.bookmarks.getChildren = async id => id === 'root' ? structuredClone(folders) : [];
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    assert.equal(store.spaces.find(s => s.id === 'a').name, 'Renamed');
    folders.push({ id: 'later', title: 'Synced later' });
    await store.dispatch({ action: 'get' });
    assert.equal(store.spaces.length, 3);
    assert.equal(store.spaces[2].bookmarkFolderId, 'later');
    assert.deepEqual(mutations, []);
});
test('space order follows the order of space folders under Arcify', async () => {
    let folders = [{ id: 'b', title: 'b' }, { id: 'loose', title: 'Loose', url: 'https://loose.test/' }, { id: 'a', title: 'a' }];
    chrome.bookmarks.getChildren = async id => id === 'root' ? structuredClone(folders) : [];
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    assert.deepEqual(store.spaces.map(s => s.id), ['b', 'a']);
    assert.deepEqual(local.spaces.map(s => s.id), ['b', 'a']);
    folders = [folders[2], folders[0], folders[1]];
    const after = await store.dispatch({ action: 'get' });
    assert.deepEqual(after.map(s => s.id), ['a', 'b']);
    assert.deepEqual(local.spaces.map(s => s.id), ['a', 'b']);
});

test('restart uses positions and unique window anchors for duplicate URLs', async () => {
    delete session.spaceSession;
    local.spaces = [space('a', [1, 3]), space('b', [2, 4, 5])];
    const duplicate = 'https://duplicate.test/';
    local.spaceTabSnapshot = [
        { tabId: 1, spaceId: 'a', section: 'temporaryTabs', order: 0, windowId: 1, index: 0, url: duplicate },
        { tabId: 2, spaceId: 'b', section: 'temporaryTabs', order: 0, windowId: 2, index: 0, url: duplicate },
        { tabId: 3, spaceId: 'a', section: 'temporaryTabs', order: 1, windowId: 1, index: 1, url: 'https://one.test/' },
        { tabId: 4, spaceId: 'b', section: 'temporaryTabs', order: 1, windowId: 2, index: 1, url: 'https://two.test/' },
        { tabId: 5, spaceId: 'b', section: 'temporaryTabs', order: 2, windowId: 2, index: 2, url: duplicate }
    ];
    tabs = [
        { id: 24, windowId: 11, index: 2, url: duplicate },
        { id: 22, windowId: 11, index: 0, url: duplicate },
        { id: 21, windowId: 12, index: 0, url: duplicate },
        { id: 23, windowId: 12, index: 1, url: 'https://one.test/' },
        { id: 25, windowId: 11, index: 1, url: 'https://two.test/' }
    ];
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    assert.deepEqual(local.spaces.map(space => space.temporaryTabs), [[21, 23], [22, 25, 24]]);
});

test('restart leaves ambiguous duplicates and legacy closed records unassigned', async () => {
    delete session.spaceSession;
    const duplicate = 'https://duplicate.test/';
    local.spaceTabSnapshot = [
        { tabId: 1, spaceId: 'a', section: 'temporaryTabs', order: 0, windowId: 1, index: 0, url: duplicate },
        { tabId: 2, spaceId: 'b', section: 'temporaryTabs', order: 0, windowId: 2, index: 0, url: duplicate },
        { tabId: 9, spaceId: 'b', section: 'temporaryTabs', order: 1, url: 'https://legacy-closed.test/' }
    ];
    tabs = [
        { id: 11, windowId: 12, index: 0, url: duplicate },
        { id: 12, windowId: 13, index: 0, url: duplicate },
        { id: 13, windowId: 13, index: 1, url: 'https://legacy-closed.test/' }
    ];
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    assert.deepEqual(local.spaces.map(space => space.temporaryTabs), [[11, 12, 13], []]);
    assert.equal(session.spaceRestoreQueue.some(record => record.tabId === 9), false);
});

test('unmatched startup entries do not take over an ordinary tab created later', async () => {
    delete session.spaceSession;
    local.spaceTabSnapshot = [{
        tabId: 2, spaceId: 'b', section: 'temporaryTabs', order: 0,
        windowId: 1, index: 1, url: 'https://missing.test/'
    }];
    tabs = [{ id: 11, windowId: 12, index: 0, url: 'https://one.test/' }];
    const store = new SpaceStore();
    store.install();
    await store.run(() => {});
    const ordinaryTab = { id: 12, windowId: 12, index: 1, url: 'https://missing.test/' };
    tabs.push(ordinaryTab);
    chrome.tabs.onCreated.emit(ordinaryTab);
    await store.run(() => store.persist());
    assert.equal(ownerOf(store.spaces, 12).id, 'a');
});

test('window-close recovery is session-local, position-matched, and expires', async t => {
    let now = 10_000;
    t.mock.method(Date, 'now', () => now);
    tabs[1].windowId = 2;
    tabs[1].index = 0;
    const store = new SpaceStore();
    store.install();
    await store.run(() => {});
    tabs.pop();
    chrome.tabs.onRemoved.emit(2, { windowId: 2, isWindowClosing: true });
    await store.run(() => store.persist());
    assert.equal(local.spaceTabSnapshot.some(record => record.tabId === 2), false);
    assert.equal(session.spaceRestoreQueue[0].expiresAt, now + restoreLifetime);
    const blank = { id: 14, windowId: 6, index: 0, url: 'chrome://newtab/' };
    tabs.push(blank);
    chrome.tabs.onCreated.emit(blank);
    await store.run(() => {});
    const navigated = { ...blank, url: 'https://two.test/' };
    tabs[tabs.length - 1] = navigated;
    chrome.tabs.onUpdated.emit(14, { url: navigated.url }, navigated);
    await store.run(() => {});
    assert.equal(ownerOf(store.spaces, 14).id, 'a');
    assert.equal(store.restoreQueue.length, 1);
    for (const tab of [
        { id: 3, windowId: 1, index: 0, url: 'https://two.test/' },
        { id: 4, windowId: 3, index: 1, url: 'https://two.test/' },
        { id: 5, windowId: 4, index: 0, url: 'https://two.test/' }
    ]) {
        tabs.push(tab);
        chrome.tabs.onCreated.emit(tab);
    }
    await store.run(() => store.persist());
    assert.deepEqual(local.spaces.map(space => space.temporaryTabs), [[1, 14, 3, 4], [5]]);
    assert.equal(session.spaceRestoreQueue.length, 0);

    tabs.pop();
    chrome.tabs.onRemoved.emit(5, { windowId: 4, isWindowClosing: true });
    await store.run(() => store.persist());
    now += restoreLifetime;
    const late = { id: 6, windowId: 5, index: 0, url: 'https://two.test/' };
    tabs.push(late);
    chrome.tabs.onCreated.emit(late);
    await store.run(() => store.persist());
    assert.equal(ownerOf(store.spaces, 6).id, 'a');
    assert.equal(session.spaceRestoreQueue.length, 0);
});

test('durable snapshot caps entries and skips oversize URLs without dropping live membership', async () => {
    tabs = [{ id: 1, windowId: 1, index: 0, url: `data:text/plain,${'x'.repeat(9000)}` },
        ...Array.from({ length: 520 }, (_, index) => ({
            id: index + 2, windowId: 1, index: index + 1, url: `https://many.test/${index}`
        }))];
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    assert.equal(local.spaces.flatMap(space => space.temporaryTabs).length, 521);
    assert.equal(local.spaceTabSnapshot.length, 500);
    assert.equal(local.spaceTabSnapshot.some(record => record.tabId === 1), false);
});

test('tab event bursts coalesce and explicit assignments await storage', async () => {
    const store = new SpaceStore();
    store.install();
    await store.run(() => {});
    const write = chrome.storage.local.set;
    let snapshotWrites = 0;
    let resolveSnapshot;
    const afterWrite = new Promise(resolve => { resolveSnapshot = resolve; });
    chrome.storage.local.set = async values => {
        await write(values);
        if (values.spaces) {
            snapshotWrites++;
            resolveSnapshot();
        }
    };
    for (const tab of [
        { id: 3, windowId: 1, index: 2, url: 'https://three.test/' },
        { id: 4, windowId: 1, index: 3, url: 'https://four.test/' },
        { id: 5, windowId: 1, index: 4, url: 'https://five.test/' }
    ]) {
        tabs.push(tab);
        chrome.tabs.onCreated.emit(tab);
    }
    await store.run(() => {});
    assert.equal(ownerOf(store.spaces, 5).id, 'a');
    assert.equal(snapshotWrites, 0);
    await afterWrite;
    await store.run(() => {});
    assert.equal(snapshotWrites, 1);
    assert.equal(ownerOf(local.spaces, 5).id, 'a');

    chrome.tabs.onActivated.emit({ tabId: 1, windowId: 1 });
    await store.dispatch({ action: 'assign', tabId: 5, spaceId: 'b', pinned: true });
    assert.equal(snapshotWrites, 2);
    assert.deepEqual(local.spaces[1].spaceBookmarks, [5]);
});

test('storage failure reaches callers and exposes only a status code to sidebars', async () => {
    const store = new SpaceStore();
    await store.dispatch({ action: 'get' });
    const notices = [];
    chrome.runtime.sendMessage = async message => notices.push(message);
    const write = chrome.storage.local.set;
    chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES exceeded'); };
    await assert.rejects(store.dispatch({ action: 'assign', tabId: 2, spaceId: 'a' }), {
        code: 'space_storage_unavailable', message: 'Space storage is unavailable.'
    });
    assert.equal(ownerOf(local.spaces, 2).id, 'b');
    chrome.storage.local.set = write;
    await store.dispatch({ action: 'get' });
    assert.equal(ownerOf(local.spaces, 2).id, 'a');
    assert.deepEqual(notices, [
        { type: 'spaceStoreStatus', code: 'space_storage_unavailable' },
        { type: 'spaceStoreStatus', code: null }
    ]);
});

for (const area of ['local', 'session']) {
    test(`a patch rejected by ${area} storage restores the last durable membership`, async () => {
        const store = new SpaceStore();
        const before = await store.dispatch({ action: 'get' });
        const after = structuredClone(before);
        after[0].temporaryTabs = [];
        after[1].temporaryTabs.push(1);
        const write = chrome.storage[area].set;
        chrome.storage[area].set = async () => { throw new Error('Synthetic storage failure'); };
        await assert.rejects(store.dispatch({ action: 'patch', before, after }), { code: 'space_storage_unavailable' });
        const expected = area === 'local' ? 'a' : 'b';
        assert.equal(ownerOf(store.spaces, 1).id, expected);
        assert.equal(ownerOf(local.spaces, 1).id, expected);
        chrome.storage[area].set = write;
        const recovered = await store.dispatch({ action: 'get', discoverBookmarks: false });
        assert.equal(ownerOf(recovered, 1).id, expected);
        assert.equal(ownerOf(local.spaces, 1).id, expected);
    });
}

for (const deletion of ['Space', 'bookmark folder']) {
    test(`a drag into a deleted ${deletion} leaves the original tab assigned`, async () => {
        const store = new SpaceStore();
        const before = await store.dispatch({ action: 'get' });
        const after = structuredClone(before);
        after[0].temporaryTabs = [];
        after[1].temporaryTabs.push(1);
        if (deletion === 'Space') await store.dispatch({ action: 'patch', before, after: before.slice(0, 1) });
        await assert.rejects(store.dispatch({
            action: 'patch', before, after, dropDestination: 'b',
            dropTransfers: [[1, { spaceId: 'b', section: 'temporaryTabs' }]]
        }), { code: 'space_drop_conflict' });
        assert.equal(ownerOf(store.spaces, 1).id, 'a');
        assert.equal(ownerOf(local.spaces, 1).id, 'a');
    });
}
