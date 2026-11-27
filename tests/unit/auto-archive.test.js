import { isTrustedExtensionMessage } from '../../message-security.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { SpaceStore, ownerOf } from '../../space-store.js';
import { isProtectedFavorite } from '../../favorite-safety.js';
import { SpaceFavorites } from '../../space-favorites.js';
import { LocalStorage } from '../../localstorage.js';
import { Utils } from '../../utils.js';
import { Logger } from '../../logger.js';
import { TabSwitcher } from '../../tab-switcher.js';
import { ElementCapture, ELEMENT_CAPTURE_COMMAND } from '../../element-capture.js';

const threshold = 360 * 60 * 1000;
const alarmName = 'autoArchiveTabsAlarm';

const source = readFileSync(new URL('../../background.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '');
let local, session, tabs, removed, alarms;
const area = data => ({
    async get(keys) {
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
        return Object.fromEntries(names.map(k => [k, structuredClone(data[k] ?? keys?.[k])]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); }
});
const space = (id, ids = []) => ({ id, spaceUuid: id, name: id, color: 'blue', bookmarkFolderId: id, spaceBookmarks: [], temporaryTabs: ids });
beforeEach(() => {
    alarms = new Map();
    local = { autoArchiveEnabled: true, spaceModelVersion: 2, spaces: [space('a', [1])], arcifyBookmarkRootId: 'root' };
    session = { spaceSession: true, tabActivitySessionInitialized: true }; removed = [];
    tabs = [{ id: 1, windowId: 1, url: 'https://one.test/', groupId: -1, active: false }];
});
function startBackground() {
    const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
    const chrome = globalThis.chrome = {
        runtime: { id: 'arcify', getURL: path => `chrome-extension://arcify/${path}`, onInstalled: event(), onStartup: event(), onMessage: event() },
        sidePanel: { setPanelBehavior: async () => {} },
        windows: {}, permissions: {},
        contextMenus: { onClicked: { addListener() {} }, remove: (_id, done) => done(), create: (_options, done) => done() },
        commands: { onCommand: event() },
        alarms: {
            onAlarm: event(),
            get: async name => alarms.get(name),
            create: async (name, options) => alarms.set(name, { ...options, scheduledTime: Date.now() + options.delayInMinutes * 60000 }),
            clear: async name => alarms.delete(name),
        },
        storage: { local: area(local), session: area(session), onChanged: event() },
        tabs: { onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(), onActivated: event(), onMoved: event(),
            query: async () => structuredClone(tabs), get: async id => structuredClone(tabs.find(t => t.id === id)),
            remove: async id => { removed.push(id); tabs = tabs.filter(t => t.id !== id); } },
        tabGroups: { onRemoved: event(), onUpdated: event(), query: async () => [] },
        bookmarks: {
            onCreated: event(), onRemoved: event(), onMoved: event(), onChanged: event(),
            search: async () => assert.fail('Bookmark identity must come from its stored ID'),
            get: async id => id === 'root' ? [{ id, title: 'Renamed PrismArc folder' }] : [],
            getChildren: async () => [],
            getSubTree: async id => { assert.equal(id, 'root'); return [{ id, children: [] }]; }
        }
    };
    runInNewContext(source, {
        registerZoomLaunchTabs() {}, ElementCapture, ELEMENT_CAPTURE_COMMAND,
        chrome, console, isTrustedExtensionMessage, setTimeout, clearTimeout,
        dispatchTourMessage: async () => ({}), registerBookmarkListeners() {}, createCleanTabsHandler: () => () => {},
        enqueueBookmarkOperation: async () => ({}), copyCurrentTabUrlWithFallback: async () => {},
        SpaceStore, ownerOf, isProtectedFavorite, SpaceFavorites, LocalStorage, Utils, Logger, TabSwitcher,
        TabSwitcherOverlay: class {
            register() {} receive() {} tabActivated() {} sourceChanged() {}
            isOnTab() { return false; } isOverlayFrame() { return false; }
        },
        TabSwitcherPreviews: class { register() {} }
    });
    return () => Promise.all(chrome.alarms.onAlarm.listeners.map(fn => fn({ name: 'autoArchiveTabsAlarm' })));
}

function requestSpace(action, extra = {}) {
    return new Promise(resolve => {
        const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('sidebar.html') };
        const message = { type: 'spaceStore', action, ...extra };
        for (const receive of chrome.runtime.onMessage.listeners) receive(message, sender, resolve);
    });
}

test('a fresh profile suggests 24 hours with auto-archive disabled and saves 24 hours when enabled', async () => {
    delete local.autoArchiveEnabled;
    startBackground();
    const settings = await Utils.getSettings();
    assert.equal(settings.autoArchiveEnabled, false);
    assert.equal(settings.autoArchiveIdleMinutes, 1440);
    assert.equal(local.autoArchiveIdleMinutes, undefined);

    await Utils.setArchivingEnabled(true);
    assert.equal(local.autoArchiveEnabled, true);
    assert.equal(local.autoArchiveIdleMinutes, 1440);
});

test('an enabled legacy profile without an interval keeps its prior six-hour threshold', async () => {
    startBackground();
    assert.equal((await Utils.getSettings()).autoArchiveIdleMinutes, 360);
    assert.equal(local.autoArchiveIdleMinutes, undefined);
    await Utils.setArchivingEnabled(false);
    assert.equal(local.autoArchiveEnabled, false);
    assert.equal(local.autoArchiveIdleMinutes, 360);
    await Utils.setArchivingEnabled(true);
    assert.equal((await Utils.getSettings()).autoArchiveIdleMinutes, 360);
});

test('toggling automation preserves previously saved standard and custom intervals', async () => {
    startBackground();
    for (const minutes of [360, 1440, 73]) {
        await Utils.setArchiveTime(minutes);
        await Utils.setArchivingEnabled(false);
        assert.equal((await Utils.getSettings()).autoArchiveIdleMinutes, minutes);
        await Utils.setArchivingEnabled(true);
        assert.equal(local.autoArchiveIdleMinutes, minutes);
    }
});

test('a background tab with no activity record is tracked instead of archived', async () => {
    local.tabLastActivity = {};
    const fireAlarm = startBackground();
    await fireAlarm();
    assert.deepEqual(removed, []);
    assert.equal(local.archivedTabs, undefined);
    assert.equal(typeof local.tabLastActivity[1], 'number');
});

test('a 24-hour threshold gets a prompt first check and startup preserves its next deadline', async () => {
    local.autoArchiveIdleMinutes = 1440;
    alarms.set(alarmName, { periodInMinutes: 720, scheduledTime: Date.now() + 12 * 3600000 });
    startBackground();
    const startup = () => Promise.all(chrome.runtime.onStartup.listeners.map(fn => fn()));
    await startup();
    const alarm = alarms.get(alarmName);
    assert.equal(alarm.delayInMinutes, 1);
    assert.equal(alarm.periodInMinutes, 15);
    await startup();
    assert.equal(alarms.get(alarmName), alarm, 'the existing alarm was kept');
    local.autoArchiveEnabled = false;
    await startup();
    assert.equal(alarms.has(alarmName), false);
});

test('first check after restart uses Chrome lastAccessed for tab IDs with no session activity', async () => {
    delete session.tabActivitySessionInitialized;
    local.autoArchiveIdleMinutes = 1440;
    const day = 24 * 3600000;
    const old = Date.now() - day - 60000;
    const recent = Date.now() - 60000;
    tabs[0].lastAccessed = old;
    tabs.push({ ...tabs[0], id: 2, url: 'https://recent.test/', lastAccessed: recent });
    local.tabLastActivity = { 1: recent, 2: old };
    local.spaces[0].temporaryTabs.push(2);
    await startBackground()();
    assert.deepEqual(removed, [1]);
    assert.equal(local.archivedTabs[0].url, 'https://one.test/');
    assert.equal(local.tabLastActivity[2], recent);
});
test('a tab idle past the threshold in the same session is archived', async () => {
    local.tabLastActivity = { 1: Date.now() - threshold - 1000 };
    await startBackground()();
    assert.deepEqual(removed, [1]);
    assert.equal(local.archivedTabs[0].url, 'https://one.test/');
});
test('a previous-session record for a reused tab id does not archive it at the first check after restart', async () => {
    session.spaceSession = false;
    delete session.tabActivitySessionInitialized;
    local.spaceTabSnapshot = [{ spaceId: 'a', section: 'temporaryTabs', order: 0, url: 'https://restored.test/' }];
    local.tabLastActivity = { 42: Date.now() - threshold - 1000 };
    tabs = [{ id: 42, windowId: 1, url: 'https://restored.test/', groupId: -1, active: false }];
    await startBackground()();
    await requestSpace('get');
    assert.deepEqual(removed, []);
    assert.deepEqual(local.spaces[0].temporaryTabs, [42]);
    assert.ok(Date.now() - local.tabLastActivity[42] < threshold);
});
test('an activation write in flight during the new-session clear does not restore previous-session records', async () => {
    session.spaceSession = false;
    delete session.tabActivitySessionInitialized;
    local.spaceTabSnapshot = [{ spaceId: 'a', section: 'temporaryTabs', order: 1, url: 'https://restored.test/' }];
    local.tabLastActivity = { 42: Date.now() - threshold - 1000 };
    tabs = [{ id: 7, windowId: 1, url: 'https://active.test/', groupId: -1, active: true },
        { id: 42, windowId: 1, url: 'https://restored.test/', groupId: -1, active: false }];
    const fireAlarm = startBackground();
    const storage = chrome.storage.local, get = storage.get, set = storage.set;
    let markCleared;
    const cleared = new Promise(resolve => { markCleared = resolve; });
    storage.set = async values => { await set(values); if ('tabLastActivity' in values) markCleared(); };
    storage.get = async keys => {
        if (keys !== 'tabLastActivity') return get(keys);
        const snapshot = await get(keys);
        await cleared;
        return snapshot;
    };
    await Promise.all(chrome.tabs.onActivated.listeners.map(fn => fn({ tabId: 7, windowId: 1 })));
    await fireAlarm();
    assert.deepEqual(removed, []);
    assert.ok(Date.now() - local.tabLastActivity[42] < threshold);
});

test('simultaneous activations retain both tabs in the activity map', async () => {
    startBackground();
    await Promise.all([7, 8].flatMap(tabId =>
        chrome.tabs.onActivated.listeners.map(fn => fn({ tabId, windowId: 1 }))));
    assert.equal(typeof local.tabLastActivity[7], 'number');
    assert.equal(typeof local.tabLastActivity[8], 'number');
});

test('a failed activity write cannot make a recently activated tab appear idle', async () => {
    const stale = Date.now() - threshold - 1000;
    local.tabLastActivity = { 1: stale };
    const fireAlarm = startBackground();
    const { set } = chrome.storage.local;
    let failActivityWrite = true;
    chrome.storage.local.set = async values => {
        if (failActivityWrite && 'tabLastActivity' in values) {
            failActivityWrite = false;
            throw new Error('QUOTA_BYTES');
        }
        await set(values);
    };
    await Promise.all(chrome.tabs.onActivated.listeners.map(fn => fn({ tabId: 1, windowId: 1 })));
    assert.equal(local.tabLastActivity[1], stale);
    await fireAlarm();
    assert.deepEqual(removed, []);
    assert.ok(local.tabLastActivity[1] > stale);
});

test('native activity protects a tab even if the saved timestamp is old', async () => {
    local.tabLastActivity = { 1: Date.now() - threshold - 1000 };
    tabs[0].lastAccessed = Date.now() - 1000;
    await startBackground()();
    assert.deepEqual(removed, []);
    assert.equal(local.archivedTabs, undefined);
});

test('auto-archive protects active and saved tabs while archiving idle tabs', async () => {
    tabs.push(
        { id: 2, windowId: 1, url: 'https://active.test/', active: true },
        { id: 3, windowId: 1, url: 'https://saved.test/path?new=true' },
        { id: 4, windowId: 1, url: 'https://audio.test/', audible: true },
        { id: 5, windowId: 1, url: 'https://idle.test/' },
        { id: 6, windowId: 1, url: 'https://also-idle.test/' }
    );
    const previousTime = Date.now() - threshold - 1000;
    local.tabLastActivity = { 2: previousTime, 3: previousTime, 4: previousTime, 5: previousTime, 6: previousTime };
    const fireAlarm = startBackground();
    chrome.bookmarks.getSubTree = async id => {
        assert.equal(id, 'root');
        return [{ id, children: [{ children: [{ url: 'https://saved.test/path?old=true' }] }] }];
    };
    await fireAlarm();
    assert.deepEqual(removed, [5, 6]);
    assert.deepEqual(Object.keys(local.tabLastActivity), ['1', '2', '3', '4']);
    assert.ok(local.tabLastActivity[3] > previousTime);
});

test('activation queued while archive storage is pending prevents closing the tab', async () => {
    local.tabLastActivity = { 1: Date.now() - threshold - 1000 };
    const previous = Array.from({ length: 100 }, (_, index) => ({
        spaceId: 'a', url: `https://archived.test/${index}`, name: 'Saved', archivedAt: index
    })).reverse();
    local.archivedTabs = previous;
    const fireAlarm = startBackground();
    const { set } = chrome.storage.local;
    let noteArchiveWrite;
    const archiveWrite = new Promise(resolve => { noteArchiveWrite = resolve; });
    let releaseArchive;
    const canWriteArchive = new Promise(resolve => { releaseArchive = resolve; });
    chrome.storage.local.set = async values => {
        if ('archivedTabs' in values) {
            noteArchiveWrite();
            await canWriteArchive;
        }
        await set(values);
    };
    const alarm = fireAlarm();
    await archiveWrite;
    const activation = Promise.all(chrome.tabs.onActivated.listeners.map(fn => fn({ tabId: 1, windowId: 1 })));
    releaseArchive();
    await Promise.all([alarm, activation]);
    assert.deepEqual(removed, []);
    assert.deepEqual(local.archivedTabs, previous);
    assert.ok(Date.now() - local.tabLastActivity[1] < threshold);
});

function suspendArchiveWrite() {
    const { set } = chrome.storage.local;
    let noteArchiveWrite, releaseArchive;
    const started = new Promise(resolve => { noteArchiveWrite = resolve; });
    const continued = new Promise(resolve => { releaseArchive = resolve; });
    let first = true;
    chrome.storage.local.set = async values => {
        if (first && 'archivedTabs' in values) {
            first = false;
            noteArchiveWrite();
            await continued;
        }
        await set(values);
    };
    return { started, releaseArchive };
}

test('a pending navigation after staging prevents closing the old URL', async () => {
    local.tabLastActivity = { 1: Date.now() - threshold - 1000 };
    const fireAlarm = startBackground();
    const { started, releaseArchive } = suspendArchiveWrite();
    const alarm = fireAlarm();
    await started;
    tabs[0].pendingUrl = 'https://navigating.test/';
    releaseArchive();
    await alarm;
    assert.deepEqual(removed, []);
    assert.deepEqual(local.archivedTabs, []);
});

test('a newly protected Favorite after staging remains open', async () => {
    local.tabLastActivity = { 1: Date.now() - threshold - 1000 };
    const fireAlarm = startBackground();
    const { started, releaseArchive } = suspendArchiveWrite();
    const alarm = fireAlarm();
    await started;
    for (const listener of chrome.bookmarks.onCreated.listeners) listener('new-bookmark', { url: tabs[0].url });
    releaseArchive();
    await alarm;
    assert.deepEqual(removed, []);
    assert.deepEqual(local.archivedTabs, []);
});

test('a tab explicitly moved after staging remains open', async () => {
    local.spaces.push(space('b'));
    local.tabLastActivity = { 1: Date.now() - threshold - 1000 };
    const fireAlarm = startBackground();
    const { started, releaseArchive } = suspendArchiveWrite();
    const alarm = fireAlarm();
    await started;
    const reply = await requestSpace('assign', { tabId: 1, spaceId: 'b' });
    releaseArchive();
    await alarm;
    assert.equal(reply.success, true);
    assert.deepEqual(removed, []);
    assert.deepEqual(local.archivedTabs, []);
});

test('an archive storage failure leaves every candidate open', async () => {
    local.tabLastActivity = { 1: Date.now() - threshold - 1000 };
    const fireAlarm = startBackground();
    const { set } = chrome.storage.local;
    chrome.storage.local.set = async values => {
        if ('archivedTabs' in values) throw new Error('QUOTA_BYTES');
        await set(values);
    };
    await fireAlarm();
    assert.deepEqual(removed, []);
    assert.equal(local.archivedTabs, undefined);
});

test('a failed native close leaves no staged row and other candidates still archive', async () => {
    tabs.push({ id: 2, windowId: 1, url: 'https://two.test/' });
    const old = Date.now() - threshold - 1000;
    local.tabLastActivity = { 1: old, 2: old };
    const fireAlarm = startBackground();
    const { remove } = chrome.tabs;
    chrome.tabs.remove = async id => {
        if (id === 1) throw new Error('Chrome did not close the tab');
        await remove(id);
    };
    await fireAlarm();
    assert.deepEqual(removed, [2]);
    assert.deepEqual(local.archivedTabs.map(tab => tab.url), ['https://two.test/']);
});

test('the same URL gets a recovery record in each owning space', async () => {
    local.spaces.push(space('b', [2]));
    tabs.push({ id: 2, windowId: 1, url: tabs[0].url });
    const old = Date.now() - threshold - 1000;
    local.tabLastActivity = { 1: old, 2: old };
    await startBackground()();
    assert.deepEqual(removed, [1, 2]);
    assert.deepEqual(local.archivedTabs.map(tab => tab.spaceId), ['a', 'b']);
});

test('archiving and removing an existing row serialize without losing a concurrent change', async () => {
    local.archivedTabs = [{ url: 'https://old.test/', spaceId: 'a', name: 'Old', archivedAt: 1 }];
    startBackground();
    const held = suspendArchiveWrite();
    const newTab = { id: 7, url: 'https://new.test/', spaceId: 'a', name: 'New' };
    const archiving = Utils.archiveTabs([newTab], async ([tab], markClosed) => markClosed(tab));
    await held.started;
    const removing = Utils.removeArchivedTab('https://old.test/', 'a');
    held.releaseArchive();
    await Promise.all([archiving, removing]);
    assert.deepEqual(local.archivedTabs.map(tab => tab.url), ['https://new.test/']);
});

test('tabs that would be outside the archive limit are left open', async () => {
    tabs = Array.from({ length: 103 }, (_, index) => ({ id: index + 1, windowId: 1, url: `https://idle.test/${index}` }));
    const old = Date.now() - threshold - 1000;
    local.tabLastActivity = Object.fromEntries(tabs.map(tab => [tab.id, old]));
    await startBackground()();
    assert.equal(local.archivedTabs.length, 100);
    assert.equal(removed.length, 100);
    assert.deepEqual(tabs.map(tab => tab.id), [101, 102, 103]);
    assert.ok(tabs.every(tab => local.tabLastActivity[tab.id] === old));
});
