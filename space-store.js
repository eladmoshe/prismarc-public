import { Logger } from './logger.js';
import { isPracticeUrl } from './tour-practice.js';
import { syncSpaceGroups } from './tab-group-sync.js';
import { LocalStorage } from './localstorage.js';
import { DEFAULT_SPACE_COLOR, LIGHT_SPACE_COLOR } from './space-colors.js';
import { boundRestoreRecords, matchStartupRestores, restoreLifetime, restoreUrl } from './space-restore.js';

const sections = ['spaceBookmarks', 'temporaryTabs'];
export const tabIds = space => sections.flatMap(key => space?.[key] || []);
export const ownerOf = (spaces, tabId) => spaces.find(space => tabIds(space).includes(tabId));
const clone = value => structuredClone(value);
const persistenceDelay = 150;
const storageUnavailable = cause => Object.assign(new Error('Space storage is unavailable.', { cause }),
    { code: 'space_storage_unavailable' });
const bookmarksUnavailable = cause => Object.assign(new Error('The space bookmark folders are unavailable.', { cause }),
    { code: 'bookmark_folder_unavailable' });

async function storageCall(operation) {
    try { return await operation(); }
    catch (error) { throw storageUnavailable(error); }
}

// The service worker is the only writer. UI patches express changes relative to the
// panel's previous view, so a stale panel cannot erase tabs created in another window.
export function applySpacePatch(current, before, after) {
    const removed = new Set(before.filter(s => !after.some(n => n.id === s.id)).map(s => s.id));
    let result = clone(current.filter(s => !removed.has(s.id)));
    for (const next of after) {
        const prev = before.find(s => s.id === next.id);
        let target = result.find(s => s.id === next.id);
        if (!target) {
            if (prev) continue; // A different panel deleted this space.
            target = { ...clone(next), spaceBookmarks: [], temporaryTabs: [] };
            result.push(target);
        }
        for (const [key, value] of Object.entries(next)) {
            if (!sections.includes(key) && JSON.stringify(value) !== JSON.stringify(prev?.[key])) target[key] = clone(value);
        }
        for (const key of sections) {
            const oldIds = prev?.[key] || [];
            const newIds = next[key] || [];
            if (JSON.stringify(oldIds) === JSON.stringify(newIds)) continue;
            const deleted = oldIds.filter(id => !newIds.includes(id));
            const added = newIds.filter(id => !oldIds.includes(id));
            for (const id of added) {
                for (const space of result) for (const section of sections) space[section] = space[section].filter(t => t !== id);
            }
            const existing = target[key].filter(id => !deleted.includes(id));
            target[key] = [...newIds.filter(id => existing.includes(id) || added.includes(id)), ...existing.filter(id => !newIds.includes(id))];
        }
    }
    if (JSON.stringify(before.map(s => s.id)) !== JSON.stringify(after.map(s => s.id))) {
        result.sort((a, b) => {
            const rank = s => { const i = after.findIndex(n => n.id === s.id); return i < 0 ? after.length : i; };
            return rank(a) - rank(b);
        });
    }
    return result;
}

export class SpaceStore {
    constructor() { this.chain = Promise.resolve(); this.initialized = false; }
    run(operation) {
        const pending = this.chain.then(async () => { await this.initialize(); return operation(); });
        this.chain = pending.catch(() => {});
        return pending;
    }
    popupUsesLightTheme(windowId, tabId) {
        if (!Number.isInteger(windowId) || windowId < 0) return Promise.resolve(false);
        return this.run(async () => {
            // The same priority as sidebar startup. Global lastActiveSpaceId
            // can describe a different window, especially with two monitors.
            let space = this.spaces.find(item => item.id === this.active[windowId]);
            if (!space) {
                const originId = tabId ?? (await chrome.tabs.query({ active: true, windowId }))[0]?.id;
                space = ownerOf(this.spaces, originId) || this.spaces[0];
            }
            return space?.color === LIGHT_SPACE_COLOR;
        });
    }
    async makeSpace(name, color, folder = null) {
        if (!folder) {
            try { folder = await LocalStorage.getOrCreateSpaceFolder(name); }
            catch (error) {
                if (error.code === 'space_storage_unavailable') throw error;
                throw bookmarksUnavailable(error);
            }
        }
        const entry = await storageCall(() =>
            LocalStorage.getOrCreateSpaceRegistryEntry(folder.id, { name, color: color || DEFAULT_SPACE_COLOR }));
        return { id: entry.spaceUuid, spaceUuid: entry.spaceUuid, uuid: entry.spaceUuid,
            bookmarkFolderId: folder.id, name, color: color || entry.color || DEFAULT_SPACE_COLOR, spaceBookmarks: [], temporaryTabs: [] };
    }
    async initialize() {
        if (this.initialized) return;
        const data = await storageCall(() => chrome.storage.local.get([
            'spaces', 'spaceModelVersion', 'spaceTabSnapshot', 'archivedTabs', 'lastActiveSpaceId', 'defaultSpaceName'
        ]));
        const session = await storageCall(() => chrome.storage.session.get([
            'spaceSession', 'spaceRestoreQueue', 'spaceRestoreWindows', 'spaceKnownWindows', 'spaceStartupPending', 'activeSpaces',
            'lastActiveSpaceId', 'restoredTabRanks'
        ]));
        this.spaces = data.spaces || [];
        this.restoreQueue = [];
        this.restoreWindows = new Map();
        this.startupPending = new Set();
        this.snapshotByTab = new Map();
        this.restoredMetadata = [];
        this.restoredRanks = new Map(session.restoredTabRanks || []);
        this.active = session.activeSpaces || {};
        this.lastActiveSpaceId = session.lastActiveSpaceId || data.lastActiveSpaceId || null;
        this.defaultSpaceName = data.defaultSpaceName || 'Home';
        const live = await chrome.tabs.query({});
        this.liveDetails = new Map(live.map(tab => [tab.id, tab]));
        this.knownWindows = new Set(live.map(tab => tab.windowId));
        let startupMatches = new Map();
        if (data.spaceModelVersion !== 2) {
            const idMap = new Map();
            const migrated = [];
            const legacyGroups = this.spaces.length ? await chrome.tabGroups.query({}) : [];
            for (const old of this.spaces) {
                const space = await this.makeSpace(old.name, old.color);
                idMap.set(old.id, space.id);
                // Legacy groups are read once to preserve existing users' membership.
                const namedGroups = legacyGroups.filter(g => g.title === old.name);
                const legacyIds = new Set(namedGroups.length ? namedGroups.map(g => g.id) : [old.id]);
                const members = live.filter(t => legacyIds.has(t.groupId) && !t.pinned);
                const pinned = old.spaceBookmarks || [];
                space.spaceBookmarks = members.filter(t => pinned.includes(t.id)).map(t => t.id);
                space.temporaryTabs = members.filter(t => !pinned.includes(t.id)).map(t => t.id);
                const existing = migrated.find(s => s.id === space.id);
                if (existing) {
                    for (const key of sections) existing[key].push(...space[key]);
                } else migrated.push(space);
            }
            this.spaces = migrated;
            if (migrated.length) await storageCall(() => chrome.storage.local.set({ tabGroupImportDismissed: true }));
            if (data.archivedTabs) await storageCall(() => chrome.storage.local.set({
                archivedTabs: data.archivedTabs.map(t => ({ ...t, spaceId: idMap.get(t.spaceId) || t.spaceId }))
            }));
        } else if (!session.spaceSession) {
            // Chrome tab IDs are session-local. Never accept an old ID after restart.
            // Older versions mixed closed tabs into the durable snapshot. A recorded
            // ID must still be listed as live in the saved space and section.
            const expiresAt = Date.now() + restoreLifetime;
            this.restoreQueue = boundRestoreRecords((data.spaceTabSnapshot || [])
                .filter(record => sections.includes(record?.section) && this.spaces.some(space =>
                    space.id === record.spaceId && (record.tabId == null || space[record.section]?.includes(record.tabId))))
                .map(record => ({ ...record, source: 'startup', expiresAt })));
            startupMatches = matchStartupRestores(this.restoreQueue, live);
            this.startupPending = new Set(live.filter(tab => !tab.pinned && !tab.incognito &&
                !tab.url && !tab.pendingUrl).map(tab => tab.id));
            this.spaces.forEach(s => { s.spaceBookmarks = []; s.temporaryTabs = []; delete s.lastTab; });
            this.active = {};
            this.restoredRanks.clear();
            this.resetTabMetadata = true;
        } else {
            this.restoreQueue = session.spaceRestoreQueue || [];
            this.pruneRestoreQueue();
            if (session.spaceKnownWindows) {
                this.knownWindows = new Set(session.spaceKnownWindows.filter(id => this.knownWindows.has(id)));
            }
            this.restoreWindows = new Map((session.spaceRestoreWindows || [])
                .filter(([id, state]) => this.knownWindows.has(id) && state.expiresAt > Date.now()));
            this.startupPending = new Set(session.spaceStartupPending || []);
            this.snapshotByTab = new Map((data.spaceTabSnapshot || []).filter(record => record?.tabId)
                .map(record => [record.tabId, record]));
        }
        await this.discoverBookmarkSpaces();
        if (!this.spaces.length) {
            this.spaces.push(await this.makeSpace(this.defaultSpaceName));
        }
        await storageCall(() => LocalStorage.syncSpaceRegistryColors(this.spaces));
        const valid = new Set(live.map(t => t.id));
        for (const space of this.spaces) for (const key of sections) space[key] = (space[key] || []).filter(id => valid.has(id));
        for (const tab of live) this.track(tab, startupMatches.get(tab.id));
        // Rebuild a missing per-window selection from the active owned tab. Session
        // storage survives worker restarts, but not a full browser restart.
        for (const tab of live.filter(tab => tab.active && !this.active[tab.windowId])) {
            const owner = ownerOf(this.spaces, tab.id);
            if (owner) this.active[tab.windowId] = owner.id;
        }
        if (!this.spaces.some(space => space.id === this.lastActiveSpaceId)) {
            this.lastActiveSpaceId = Object.values(this.active)
                .find(spaceId => this.spaces.some(space => space.id === spaceId)) || null;
        }
        this.initialized = true;
        await this.persist();
    }
    // Bookmark folders are durable space definitions regardless of Chrome group sync.
    // Run on every worker startup and sidebar read, including version-2 installations.
    async discoverBookmarkSpaces() {
        const before = JSON.stringify(this.spaces);
        let folders;
        try {
            const root = await LocalStorage.getOrCreateArcifyFolder();
            folders = (await chrome.bookmarks.getChildren(root.id)).filter(node => !node.url);
        } catch (error) {
            if (error.code === 'space_storage_unavailable') throw error;
            throw bookmarksUnavailable(error);
        }
        for (const folder of folders) {
            let space = this.spaces.find(space => space.bookmarkFolderId === folder.id);
            if (!space) {
                // Recover a missing/stale folder association without duplicating the space.
                space = this.spaces.find(space => space.name === folder.title && !folders.some(node => node.id === space.bookmarkFolderId));
                if (space) space.bookmarkFolderId = folder.id;
                else { this.spaces.push(await this.makeSpace(folder.title, undefined, folder)); continue; }
            }
            space.name = folder.title;
        }
        const unconfigured = this.spaces.filter(space => !space.color);
        if (unconfigured.length) {
            const registry = await storageCall(() => LocalStorage.getSpaceRegistry());
            for (const space of unconfigured) {
                space.color = registry[space.bookmarkFolderId]?.color || DEFAULT_SPACE_COLOR;
            }
        }
        // Bookmark folders are durable, so discovery also restores their order in the switcher.
        const rank = new Map(folders.map((folder, index) => [folder.id, index]));
        this.spaces.sort((a, b) =>
            (rank.get(a.bookmarkFolderId) ?? folders.length) - (rank.get(b.bookmarkFolderId) ?? folders.length));
        return before !== JSON.stringify(this.spaces);
    }
    pruneRestoreQueue() {
        const now = Date.now();
        const validSpaces = new Set(this.spaces.map(space => space.id));
        this.restoreQueue = boundRestoreRecords(this.restoreQueue.filter(record => record?.expiresAt > now
            && sections.includes(record.section) && validSpaces.has(record.spaceId)));
    }
    registerWindow(tab) {
        if (this.knownWindows.has(tab.windowId)) return;
        this.knownWindows.add(tab.windowId);
        // A normal new-tab page marks an ordinary new window. Chrome can
        // instead report an as-yet unresolved address for a restored tab.
        if (tab.incognito || tab.openerTabId || (!restoreUrl(tab) && (tab.url || tab.pendingUrl))) return;
        const now = Date.now();
        if (this.restoreQueue.some(record => record.source === 'closed' && record.expiresAt > now)) {
            this.restoreWindows.set(tab.windowId, { expiresAt: now + restoreLifetime, pendingTabs: [] });
        }
    }
    matchClosedWindow(tab) {
        const now = Date.now();
        const window = this.restoreWindows.get(tab.windowId);
        const url = restoreUrl(tab);
        if (!url || !window || window.expiresAt <= now || tab.openerTabId || !Number.isInteger(tab.index)) return;
        const matches = this.restoreQueue.filter(record => record.source === 'closed' && record.expiresAt > now
            && record.url === url && record.index === tab.index && record.windowId !== tab.windowId
            && (window.sourceWindowId === undefined || window.sourceWindowId === record.windowId)
            && ![...this.restoreWindows].some(([id, state]) =>
                id !== tab.windowId && state.expiresAt > now && state.sourceWindowId === record.windowId));
        if (matches.length === 1) {
            window.sourceWindowId = matches[0].windowId;
            return matches[0];
        }
    }
    track(tab, restored, isCreated = false) {
        const url = tab.url || tab.pendingUrl;
        this.liveDetails.set(tab.id, tab);
        if (isCreated) this.registerWindow(tab);
        if (tab.pinned) {
            this.startupPending.delete(tab.id);
            for (const space of this.spaces) for (const key of sections) space[key] = space[key].filter(id => id !== tab.id);
            return;
        }
        if (url?.startsWith(chrome.runtime?.getURL?.('') || 'chrome-extension://invalid/') && !isPracticeUrl(url)) {
            this.startupPending.delete(tab.id);
            for (const space of this.spaces) for (const key of sections) space[key] = space[key].filter(id => id !== tab.id);
            return;
        }
        if (!tab.incognito && !restored) {
            if (this.startupPending.has(tab.id) && restoreUrl(tab)) {
                const now = Date.now();
                restored = matchStartupRestores(this.restoreQueue.filter(record => record.source === 'startup' &&
                    record.expiresAt > now), [...this.liveDetails.values()]).get(tab.id);
                this.startupPending.delete(tab.id);
            }
            const state = this.restoreWindows.get(tab.windowId);
            if (state) {
                const pendingIndex = state.pendingTabs.indexOf(tab.id);
                if (isCreated && !url && !tab.openerTabId && pendingIndex < 0) state.pendingTabs.push(tab.id);
                if (url && pendingIndex >= 0) state.pendingTabs.splice(pendingIndex, 1);
                if (!restored && (isCreated || pendingIndex >= 0)) restored = this.matchClosedWindow(tab);
            }
        }
        const existing = ownerOf(this.spaces, tab.id);
        if (existing) {
            if (!restored) return;
            for (const key of sections) existing[key] = existing[key].filter(id => id !== tab.id);
        }
        if (restored) this.restoreQueue = this.restoreQueue.filter(record => record !== restored);
        // Chrome can attach the current tab as opener even for Cmd/Ctrl+T.
        // A blank new-tab page belongs to the selected space, not that incidental opener.
        const isNewTabPage = !url || /^(chrome:\/\/(newtab|new-tab-page)\/?|about:blank)$/.test(url);
        const openerSpace = isNewTabPage ? null : ownerOf(this.spaces, tab.openerTabId);
        const selectedSpace = this.spaces.find(s => s.id === this.active[tab.windowId])
            || this.spaces.find(s => s.id === this.lastActiveSpaceId);
        const space = this.spaces.find(s => s.id === restored?.spaceId) || openerSpace
            || selectedSpace
            || this.spaces.find(s => s.name === this.defaultSpaceName) || this.spaces[0];
        if (!space) return;
        const key = restored?.section || 'temporaryTabs';
        if (restored) {
            this.restoredMetadata.push({ ...restored, tabId: tab.id });
            // Preserve extension order when Chrome restores tabs in a different order.
            this.restoredRanks.set(tab.id, restored.order);
            space[key].push(tab.id);
            space[key].sort((a, b) => (this.restoredRanks.get(a) ?? Infinity) - (this.restoredRanks.get(b) ?? Infinity));
        } else {
            const openerIndex = space[key].indexOf(tab.openerTabId);
            if (openerIndex >= 0) space[key].splice(openerIndex + 1, 0, tab.id);
            else space[key].push(tab.id);
        }
    }
    schedulePersistence() {
        this.persistencePending = true;
        if (this.persistenceTimer) return;
        // A short, fixed window coalesces native events without postponing writes
        // indefinitely during a burst. Requests that mutate spaces still await disk.
        this.persistenceTimer = setTimeout(() => {
            this.persistenceTimer = null;
            this.run(() => this.persistencePending && this.persist()).catch(error => this.reportFailure(error));
        }, persistenceDelay);
    }
    reportFailure(error) {
        Logger.error(Logger.context('Could not update the space model.'), error);
        if (!error.code || this.failureCode === error.code) return;
        if (this.initialized) this.persistenceFailed = true;
        this.failureCode = error.code;
        chrome.runtime?.sendMessage?.({ type: 'spaceStoreStatus', code: error.code })?.catch?.(() => {});
    }
    clearFailure(code) {
        if (this.failureCode !== code) return;
        this.failureCode = null;
        chrome.runtime?.sendMessage?.({ type: 'spaceStoreStatus', code: null })?.catch?.(() => {});
    }
    async persist() {
        clearTimeout(this.persistenceTimer);
        this.persistenceTimer = null;
        this.persistencePending = true;
        try {
            await this.writeSnapshot();
            this.persistencePending = false;
            this.persistenceFailed = false;
            this.clearFailure('space_storage_unavailable');
        } catch (error) {
            this.persistenceFailed = true;
            throw error;
        }
    }
    async writeSnapshot() {
        const tabs = new Map((await chrome.tabs.query({})).map(t => [t.id, t]));
        this.pruneRestoreQueue();
        for (const [id, state] of this.restoreWindows) {
            if (state.expiresAt <= Date.now()) this.restoreWindows.delete(id);
            else state.pendingTabs = state.pendingTabs.filter(tabId => tabs.has(tabId));
        }
        const hasStartupRecords = this.restoreQueue.some(record => record.source === 'startup');
        for (const id of this.startupPending) {
            if (!tabs.has(id) || !hasStartupRecords) this.startupPending.delete(id);
        }
        if (!this.startupPending.size) this.restoreQueue = this.restoreQueue.filter(record => record.source !== 'startup');
        const metadata = this.resetTabMetadata ? {} : await storageCall(() =>
            chrome.storage.local.get(['pinnedTabStatesById', 'tabNameOverridesById']));
        const pinnedStates = metadata.pinnedTabStatesById || {};
        const overrides = metadata.tabNameOverridesById || {};
        for (const record of this.restoredMetadata) {
            if (!tabs.has(record.tabId)) continue;
            if (record.pinnedState && !pinnedStates[record.tabId]) pinnedStates[record.tabId] = record.pinnedState;
            if (record.nameOverride && !overrides[record.tabId]) overrides[record.tabId] = record.nameOverride;
        }
        const snapshot = [];
        const liveIds = new Set();
        for (const space of this.spaces) for (const section of sections) {
            space[section] = [...new Set(space[section])].filter(id => tabs.has(id));
            space[section].forEach((id, order) => {
                const tab = tabs.get(id);
                liveIds.add(id);
                if (!restoreUrl(tab) || tab.incognito || tab.pinned) return;
                const record = { tabId: id, spaceId: space.id, section, order, url: restoreUrl(tab),
                    windowId: tab.windowId, index: tab.index,
                    ...(pinnedStates[id] ? { pinnedState: pinnedStates[id] } : {}),
                    ...(overrides[id] ? { nameOverride: overrides[id] } : {}) };
                snapshot.push(record);
            });
        }
        for (const id of this.restoredRanks.keys()) if (!liveIds.has(id)) this.restoredRanks.delete(id);
        this.liveDetails = tabs;
        const nextSnapshot = boundRestoreRecords(snapshot);
        // A removal callback can be queued while tabs.query is in flight.
        this.previousSnapshotByTab = this.snapshotByTab;
        this.snapshotByTab = new Map(nextSnapshot.map(record => [record.tabId, record]));
        await storageCall(() => chrome.storage.local.set({
            spaces: clone(this.spaces), spaceModelVersion: 2, spaceTabSnapshot: nextSnapshot,
            lastActiveSpaceId: this.lastActiveSpaceId,
            ...(this.resetTabMetadata || this.restoredMetadata.length ?
                { pinnedTabStatesById: pinnedStates, tabNameOverridesById: overrides } : {})
        }));
        this.restoredMetadata = [];
        this.resetTabMetadata = false;
        await storageCall(() => chrome.storage.session.set({
            spaceSession: true, activeSpaces: this.active, lastActiveSpaceId: this.lastActiveSpaceId,
            spaceRestoreQueue: this.restoreQueue, spaceRestoreWindows: [...this.restoreWindows],
            spaceKnownWindows: [...this.knownWindows], spaceStartupPending: [...this.startupPending],
            restoredTabRanks: [...this.restoredRanks]
        }));
        try { await syncSpaceGroups(this.spaces, this.active); }
        catch (error) { Logger.warn('Tab group sync deferred:', error); }
    }
    async dispatch(message) {
        return this.run(async () => {
            switch (message.action) {
                case 'get':
                    if ((message.discoverBookmarks !== false && await this.discoverBookmarkSpaces()) ||
                        this.persistenceFailed || this.restoredMetadata.length) {
                        await this.persist();
                    }
                    if (message.discoverBookmarks !== false) this.clearFailure('bookmark_folder_unavailable');
                    break;
                case 'patch': {
                    for (const next of message.after) {
                        const prev = message.before.find(s => s.id === next.id);
                        for (const key of sections) if (JSON.stringify(next[key]) !== JSON.stringify(prev?.[key])) {
                            for (const id of next[key] || []) this.restoredRanks.delete(id);
                        }
                    }
                    const previous = this.spaces;
                    this.spaces = applySpacePatch(previous, message.before, message.after);
                    const colorChanges = this.spaces.filter(space =>
                        space.color && previous.find(old => old.id === space.id)?.color !== space.color);
                    if (colorChanges.length) await storageCall(() => LocalStorage.syncSpaceRegistryColors(colorChanges));
                    if (!this.spaces.length) this.spaces.push(await this.makeSpace(this.defaultSpaceName));
                    break;
                }
                case 'activate':
                    this.active[message.windowId] = message.spaceId;
                    this.lastActiveSpaceId = message.spaceId;
                    break;
                case 'assign': {
                    const target = this.spaces.find(s => s.id === message.spaceId);
                    if (target) {
                        this.startupPending.delete(message.tabId);
                        this.restoredRanks.delete(message.tabId);
                        for (const space of this.spaces) for (const key of sections) space[key] = space[key].filter(id => id !== message.tabId);
                        target[message.pinned ? 'spaceBookmarks' : 'temporaryTabs'].push(message.tabId);
                    }
                    break;
                }
                case 'import': {
                    const groups = await chrome.tabGroups.query({ windowId: message.windowId });
                    const tabs = await chrome.tabs.query({ windowId: message.windowId });
                    for (const group of groups) {
                        let name = group.title || 'Imported space';
                        const base = name;
                        for (let i = 2; this.spaces.some(s => s.name === name); i++) name = `${base} ${i}`;
                        const space = await this.makeSpace(name, group.color);
                        const ids = tabs.filter(t => t.groupId === group.id && !t.pinned).map(t => t.id);
                        for (const old of this.spaces) for (const key of sections) old[key] = old[key].filter(id => !ids.includes(id));
                        space.temporaryTabs = ids;
                        this.spaces.push(space);
                    }
                    await storageCall(() => chrome.storage.local.set({ tabGroupImportDismissed: true }));
                    break;
                }
                default: throw new Error('Unknown space action');
            }
            if (message.action !== 'get') await this.persist();
            return clone(this.spaces);
        }).catch(error => {
            this.reportFailure(error);
            throw error;
        });
    }
    install() {
        const handle = operation => this.run(() => {
            operation();
            this.schedulePersistence();
        }).catch(error => this.reportFailure(error));
        chrome.tabs.onCreated.addListener(tab => handle(() => this.track(tab, undefined, true)));
        chrome.tabs.onUpdated.addListener((id, change, tab) => {
            if (change.url || change.pinned !== undefined) handle(() => this.track(tab));
        });
        chrome.tabs.onRemoved.addListener((id, info) => handle(() => {
            const previous = this.snapshotByTab.get(id) || this.previousSnapshotByTab?.get(id);
            const tab = this.liveDetails.get(id);
            const space = ownerOf(this.spaces, id);
            const section = sections.find(key => space?.[key].includes(id));
            const url = (tab && restoreUrl(tab)) || previous?.url;
            const windowId = info?.windowId ?? tab?.windowId ?? previous?.windowId;
            const index = tab?.index ?? previous?.index;
            if (info?.isWindowClosing) {
                this.knownWindows.delete(windowId);
                this.restoreWindows.delete(windowId);
                delete this.active[windowId];
                if (url && !tab?.incognito && !tab?.pinned && Number.isInteger(windowId) && Number.isInteger(index) && (space || previous)) {
                    this.restoreQueue.unshift({
                        ...previous, tabId: id, spaceId: space?.id ?? previous.spaceId,
                        section: section ?? previous.section, order: previous?.order ?? space[section].indexOf(id),
                        url, windowId, index, source: 'closed', expiresAt: Date.now() + restoreLifetime
                    });
                }
            }
            this.snapshotByTab.delete(id);
            this.previousSnapshotByTab?.delete(id);
            this.liveDetails.delete(id);
            this.startupPending.delete(id);
            this.restoredRanks.delete(id);
            for (const space of this.spaces) {
                for (const key of sections) space[key] = space[key].filter(t => t !== id);
                if (space.lastTab === id) delete space.lastTab;
            }
        }));
        chrome.tabs.onReplaced.addListener((added, removed) => handle(() => {
            const record = this.snapshotByTab.get(removed);
            if (record) this.snapshotByTab.set(added, { ...record, tabId: added });
            this.snapshotByTab.delete(removed);
            const tab = this.liveDetails.get(removed);
            if (tab) this.liveDetails.set(added, { ...tab, id: added });
            this.liveDetails.delete(removed);
            if (this.startupPending.delete(removed)) this.startupPending.add(added);
            if (tab) {
                const window = this.restoreWindows.get(tab.windowId);
                const pendingIndex = window?.pendingTabs.indexOf(removed) ?? -1;
                if (pendingIndex >= 0) window.pendingTabs[pendingIndex] = added;
            }
            const rank = this.restoredRanks.get(removed);
            if (rank !== undefined) this.restoredRanks.set(added, rank);
            this.restoredRanks.delete(removed);
            for (const space of this.spaces) {
                for (const key of sections) space[key] = space[key].map(id => id === removed ? added : id);
                if (space.lastTab === removed) space.lastTab = added;
            }
        }));
        chrome.tabs.onActivated.addListener(info => handle(() => {
            const space = ownerOf(this.spaces, info.tabId);
            if (space) {
                space.lastTab = info.tabId;
                this.active[info.windowId] = space.id;
                this.lastActiveSpaceId = space.id;
            }
        }));
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && (changes.pinnedTabStatesById || changes.tabNameOverridesById)) handle(() => {});
            if (area === 'local' && changes.syncTabGroups) handle(() => {});
            if (area === 'local' && changes.defaultSpaceName) handle(() => { this.defaultSpaceName = changes.defaultSpaceName.newValue || 'Home'; });
        });
        // Capture native tab positions for restart recovery. Group changes only
        // request a projection, which shares the scheduled snapshot when possible.
        chrome.tabs.onMoved.addListener(() => handle(() => {}));
        chrome.tabs.onAttached?.addListener((id, info) => handle(() => this.knownWindows.add(info.newWindowId)));
        let syncTimer;
        const scheduleSync = () => {
            if (syncTimer) return;
            syncTimer = setTimeout(() => {
                syncTimer = null;
                this.run(() => {
                    if (!this.persistencePending) return syncSpaceGroups(this.spaces, this.active);
                }).catch(error => this.reportFailure(error));
            }, 200);
        };
        chrome.tabs.onUpdated.addListener((id, change) => { if (change.groupId !== undefined) scheduleSync(); });
        chrome.tabGroups.onRemoved.addListener(scheduleSync);
        chrome.tabGroups.onUpdated.addListener(scheduleSync);
        this.run(() => {}).catch(error => this.reportFailure(error));
    }
}
