import { DEFAULT_SPACE_COLOR } from './space-colors.js';
import { isPracticeUrl } from './tour-practice.js';
import { getSpaceTabs, spaceRequest } from './space-client.js';
/**
 * Utils - Shared utility functions and storage management
 * 
 * Purpose: Provides common utilities and centralized settings/storage management across the extension
 * Key Functions: Settings CRUD, archived tabs management, space data operations, default configurations
 * Architecture: Static utility class with async storage operations
 * 
 * Critical Notes:
 * - Central source of truth for extension settings and defaults
 * - Keeps settings and spaces/tabs data in chrome.storage.local
 * - Used by both background script and UI components for consistent data access
 * - Settings changes automatically sync across extension contexts
 */

import { BookmarkUtils } from './bookmark-utils.js';
import { Logger } from './logger.js';

const MAX_ARCHIVED_TABS = 100;
const ARCHIVED_TABS_KEY = 'archivedTabs';
const DEFAULT_ARCHIVE_IDLE_MINUTES = 24 * 60;
const LEGACY_ARCHIVE_IDLE_MINUTES = 6 * 60;
let archiveWrites = Promise.resolve();

function updateArchive(operation) {
    const locks = globalThis.navigator?.locks;
    if (locks) return locks.request('prismarc-archive', operation);
    const pending = archiveWrites.then(operation);
    archiveWrites = pending.catch(() => {});
    return pending;
}

const archiveKey = ({ url, spaceId }) => JSON.stringify([spaceId, url]);
const newestArchive = (added, existing) =>
    [...added, ...existing].sort((a, b) => b.archivedAt - a.archivedAt).slice(0, MAX_ARCHIVED_TABS);
async function readArchive() {
    const result = await chrome.storage.local.get(ARCHIVED_TABS_KEY);
    return result[ARCHIVED_TABS_KEY] || [];
}
function writeArchive(tabs) {
    return chrome.storage.local.set({ [ARCHIVED_TABS_KEY]: tabs });
}

const Utils = {

    async focusTab(tabId) {
        const tab = await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return tab;
    },

    processBookmarkFolder: async function (folder, spaceId) {
        const bookmarks = [];
        const items = await chrome.bookmarks.getChildren(folder.id);
        const tabs = await getSpaceTabs(spaceId);
        for (const item of items) {
            if (item.url) {
                // This is a bookmark
                const tab = tabs.find(t => t.url === item.url);
                if (tab) {
                    bookmarks.push(tab.id);
                    // Set tab name override with the bookmark's title
                    if (item.title && item.title !== tab.title) { // Only override if bookmark title is present and different
                        await this.setTabNameOverride(tab.id, tab.url, item.title);
                        Logger.log(`Override set for tab ${tab.id} from bookmark: ${item.title}`);
                    }
                }
            } else {
                // This is a folder, recursively process it
                const subFolderBookmarks = await this.processBookmarkFolder(item, spaceId);
                bookmarks.push(...subFolderBookmarks);
            }
        }

        return bookmarks;
    },

    // Helper function to generate UUID (If you want to move this too)
    generateUUID: function () {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    },

    // Helper function to fetch favicon
    getFaviconUrl: function (u, size = "16") {
        const url = new URL(chrome.runtime.getURL("/_favicon/"));
        url.searchParams.set("pageUrl", u);
        url.searchParams.set("size", size);
        return url.toString();
    },

    // URL comparison key for pinned tabs:
    // intentionally ignore query params + hash to avoid treating benign changes (e.g. Google Docs) as "navigated away".
    getPinnedUrlKey: function (url) {
        if (!url) return '';
        // Each local lesson/run is a distinct practice tab, even though it shares a page.
        if (isPracticeUrl(url)) return url;
        try {
            const u = new URL(url);
            return `${u.origin}${u.pathname}`;
        } catch {
            // Fallback for non-standard URLs
            return String(url).split('#')[0].split('?')[0];
        }
    },

    getSettings: async function () {
        const defaultSettings = {
            defaultSpaceName: 'Home',
            autoArchiveEnabled: false, // Default: disabled
            autoArchiveIdleMinutes: null,
            syncTabGroups: false,
            invertTabOrder: true, // Default: enabled (new temporary tabs on top; favorites keep bookmark order)
            colorOverrides: null, // Default: no color overrides
            debugLoggingEnabled: false, // Default: disabled (controls debug logging)
            showAllOpenTabsInCollapsedFolders: false,
        };
        const result = await chrome.storage.local.get(defaultSettings);
        result.autoArchiveIdleMinutes ??= result.autoArchiveEnabled
            ? LEGACY_ARCHIVE_IDLE_MINUTES
            : DEFAULT_ARCHIVE_IDLE_MINUTES;
        Logger.log("Retrieved settings:", result);
        return result;
    },

    // Get all overrides (keyed by tabId)
    getTabNameOverrides: async function () {
        const result = await chrome.storage.local.get('tabNameOverridesById'); // Changed key
        return result.tabNameOverridesById || {}; // Changed key
    },

    // Save all overrides (keyed by tabId)
    saveTabNameOverrides: async function (overrides) {
        await chrome.storage.local.set({ tabNameOverridesById: overrides }); // Changed key
    },

    // Set or update a single override using tabId
    setTabNameOverride: async function (tabId, url, name) { // Added tabId, kept url for domain
        if (!tabId || !url || !name) return; // Basic validation

        const overrides = await this.getTabNameOverrides();
        try {
            // Still store originalDomain in case we need it later, derived from the URL at time of setting
            const originalDomain = new URL(url).hostname;
            overrides[tabId] = { name: name, originalDomain: originalDomain }; // Use tabId as key
            await this.saveTabNameOverrides(overrides);
            Logger.log(`Override set for tab ${tabId}: ${name}`);
        } catch (e) {
            Logger.error("Error setting override - invalid URL?", url, e);
        }
    },

    // Remove an override using tabId
    removeTabNameOverride: async function (tabId) { // Changed parameter to tabId
        if (!tabId) return;

        const overrides = await this.getTabNameOverrides();
        if (overrides[tabId]) { // Check using tabId
            delete overrides[tabId]; // Delete using tabId
            await this.saveTabNameOverrides(overrides);
            Logger.log(`Override removed for tab ${tabId}`);
        }
    },

    // --- Pinned (Space Bookmark) Tab State ---
    // Tracks the original "pinned/bookmark URL" for a pinned tab, even if the user navigates away.
    // Keyed by ephemeral tabId (per session) which is sufficient for Arc-like "Back to Pinned URL".
    getPinnedTabStates: async function () {
        const result = await chrome.storage.local.get('pinnedTabStatesById');
        return result.pinnedTabStatesById || {};
    },

    savePinnedTabStates: async function (states) {
        await chrome.storage.local.set({ pinnedTabStatesById: states || {} });
    },

    getPinnedTabState: async function (tabId) {
        if (!tabId) return null;
        const states = await this.getPinnedTabStates();
        return states[tabId] || null;
    },

    // Serialization chain for pinnedTabStatesById read-modify-write ops. Without this,
    // concurrent set/remove callers (e.g. sidebar init's Promise.all over groups) each read
    // the SAME base object and write it back, so the last write clobbers earlier bindings —
    // dropping favorites' tab<->bookmark links (B10). Chaining makes each op atomic.
    _pinnedStateChain: Promise.resolve(),
    _serializePinnedStateOp: function (op) {
        const run = this._pinnedStateChain.then(op, op);
        // Keep the chain alive even if an op rejects, so one failure can't wedge the queue.
        this._pinnedStateChain = run.then(() => { }, () => { });
        return run;
    },

    setPinnedTabState: async function (tabId, state) {
        if (!tabId || !state) return;
        return this._serializePinnedStateOp(async () => {
            const states = await this.getPinnedTabStates();
            states[tabId] = {
                pinnedUrl: state.pinnedUrl || null,
                bookmarkId: state.bookmarkId || null
            };
            await this.savePinnedTabStates(states);
        });
    },

    removePinnedTabState: async function (tabId) {
        if (!tabId) return;
        return this._serializePinnedStateOp(async () => {
            const states = await this.getPinnedTabStates();
            if (states[tabId]) {
                delete states[tabId];
                await this.savePinnedTabStates(states);
            }
        });
    },

    // Drop pinnedTabStatesById entries whose tab id is no longer a live tab. Keyed by
    // ephemeral tab id, this map otherwise accumulates dead keys across restarts, and a
    // reused id could inherit a stale binding (B11). Called once on startup. Pass ALL live
    // tab ids (across windows) so multi-window bindings aren't wrongly pruned.
    prunePinnedTabStates: async function (validTabIds) {
        const valid = new Set((validTabIds || []).map(id => String(id)));
        return this._serializePinnedStateOp(async () => {
            const states = await this.getPinnedTabStates();
            let changed = false;
            for (const key of Object.keys(states)) {
                if (!valid.has(String(key))) {
                    delete states[key];
                    changed = true;
                }
            }
            if (changed) await this.savePinnedTabStates(states);
        });
    },

    getSpaceColor: async function (groupName, fallback = DEFAULT_SPACE_COLOR) {
        const spaces = await spaceRequest('get', { discoverBookmarks: false });
        return spaces.find(s => s.name === groupName)?.color || fallback;
    },

    // Function to get if archiving is enabled
    isArchivingEnabled: async function () {
        const settings = await this.getSettings();
        return settings.autoArchiveEnabled;
    },

    // Get all archived tabs
    getArchivedTabs: () => updateArchive(readArchive),

    archiveTabs: function (tabs, removeTabs) {
        return updateArchive(async () => {
            const existing = await readArchive();
            const seen = new Set(existing.map(archiveKey));
            const candidates = tabs.filter(tab => tab?.url && tab.name && tab.spaceId);
            const additions = [];
            const archivedAt = Date.now();
            for (const { url, name, spaceId } of candidates) {
                const record = { url, name, spaceId, archivedAt };
                const key = archiveKey(record);
                if (seen.has(key)) continue;
                additions.push(record);
                seen.add(key);
            }
            const staged = additions.length ? newestArchive(additions, existing) : existing;
            const retained = new Set(staged.map(archiveKey));
            const stagedAdditions = additions.filter(record => retained.has(archiveKey(record)));
            // Each removal must already have a durable record in its space.
            if (stagedAdditions.length) await writeArchive(staged);
            const closed = new Set();
            try {
                await removeTabs(candidates.filter(tab => retained.has(archiveKey(tab))),
                    tab => closed.add(archiveKey(tab)));
            } finally {
                const completed = stagedAdditions.filter(record => closed.has(archiveKey(record)));
                if (completed.length !== stagedAdditions.length) {
                    // Recover earlier records displaced by a tab that remained open.
                    await writeArchive(newestArchive(completed, existing));
                }
            }
        });
    },

    // Function to archive a tab (likely called from context menu)
    archiveTab: async function (tabId) {
        try {
            const tab = await chrome.tabs.get(tabId);
            const spaces = await spaceRequest('get', { discoverBookmarks: false });
            const space = spaces.find(s => [...s.spaceBookmarks, ...s.temporaryTabs].includes(tabId));
            if (!tab || !space) return;

            const wanted = { id: tabId, url: tab.url, name: tab.title || tab.url, spaceId: space.id };
            await this.archiveTabs([wanted], async ([candidate], markClosed) => {
                if (!candidate) return;
                const current = await chrome.tabs.get(candidate.id).catch(() => null);
                if (!current || (current.pendingUrl || current.url) !== candidate.url) return;
                await chrome.tabs.remove(candidate.id);
                markClosed(candidate);
            });

        } catch (error) {
            Logger.error(`Error archiving tab ${tabId}:`, error);
        }
    },

    // Remove a tab from the archive (e.g., after restoration)
    removeArchivedTab: async function (url, spaceId) {
        if (!url || !spaceId) return;

        await updateArchive(async () => {
            const archivedTabs = await readArchive();
            const remaining = archivedTabs.filter(tab => !(tab.url === url && tab.spaceId === spaceId));
            if (remaining.length !== archivedTabs.length) await writeArchive(remaining);
        });
        Logger.log(`Removed archived tab: ${url} from space ${spaceId}`);
    },

    restoreArchivedTab: async function (archivedTabData) {
        try {
            // Reopen the archived URL and restore its extension-owned membership.
            const newTab = await chrome.tabs.create({
                url: archivedTabData.url,
                active: true, // Make it active
                // windowId: currentWindow.id // Ensure it's in the current window
            });

            await spaceRequest('assign', { tabId: newTab.id, spaceId: archivedTabData.spaceId });

            // Remove from archive storage
            await this.removeArchivedTab(archivedTabData.url, archivedTabData.spaceId);

            // Return the created tab so caller can pin it if needed
            return newTab;

        } catch (error) {
            Logger.error(`Error restoring archived tab ${archivedTabData.url}:`, error);
            throw error;
        }
    },

    setArchivingEnabled: async function (enabled) {
        const stored = await chrome.storage.local.get(['autoArchiveEnabled', 'autoArchiveIdleMinutes']);
        const next = { autoArchiveEnabled: enabled };
        if (stored.autoArchiveIdleMinutes == null && (enabled || stored.autoArchiveEnabled)) {
            // Save the effective threshold with the toggle so enabling a fresh
            // profile does not pick up the legacy enabled-profile default.
            next.autoArchiveIdleMinutes = stored.autoArchiveEnabled
                ? LEGACY_ARCHIVE_IDLE_MINUTES
                : DEFAULT_ARCHIVE_IDLE_MINUTES;
        }
        await chrome.storage.local.set(next);
    },

    setArchiveTime: async function (minutes) {
        await chrome.storage.local.set({ autoArchiveIdleMinutes: minutes });
    },

    // Get Arc-like positioning setting (when enabled, tabs append to end instead of syncing with Chrome)
    getUseArcLikePositioning: async function () {
        const settings = await this.getSettings();
        return settings.useArcLikePositioning;
    },

    // Set Arc-like positioning setting
    setUseArcLikePositioning: async function (enabled) {
        await chrome.storage.local.set({ useArcLikePositioning: enabled });
    },

    getInvertTabOrder: async function () {
        const settings = await this.getSettings();
        return settings.invertTabOrder;
    },

    setInvertTabOrder: async function (enabled) {
        await chrome.storage.local.set({ invertTabOrder: enabled });
    },


    // Navigate to adjacent tab within a space (next or previous)
    _navigateTabInSpace: async function (tabId, sourceSpace, direction) {
        const temporaryTabs = sourceSpace?.temporaryTabs ?? [];
        const spaceBookmarks = sourceSpace?.spaceBookmarks ?? [];
        const currentTab = await chrome.tabs.get(tabId);
        const windowTabs = new Set((await chrome.tabs.query({ windowId: currentTab.windowId })).map(t => t.id));
        const allTabs = [...spaceBookmarks, ...temporaryTabs].filter(id => windowTabs.has(id));

        if (allTabs.length === 0) return;

        const currentIndex = allTabs.indexOf(tabId);
        if (currentIndex === -1) return;

        const nextIndex = direction === 'next'
            ? (currentIndex + 1) % allTabs.length
            : (currentIndex - 1 + allTabs.length) % allTabs.length;

        await chrome.tabs.update(allTabs[nextIndex], { active: true });
    },

    moveToNextTabInSpace: async function (tabId, sourceSpace) {
        return this._navigateTabInSpace(tabId, sourceSpace, 'next');
    },

    moveToPrevTabInSpace: async function (tabId, sourceSpace) {
        return this._navigateTabInSpace(tabId, sourceSpace, 'prev');
    },

    // Helper function to adjust menu position to keep it within viewport
    adjustMenuPosition: function (menu, x, y) {
        // Ensure menu is in DOM to get dimensions
        if (!menu.isConnected) {
            Logger.warn('Menu must be in DOM to adjust position');
            return;
        }

        const rect = menu.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let left = x;
        let top = y;

        // Check right edge
        if (left + rect.width > viewportWidth) {
            left = viewportWidth - rect.width - 5; // 5px padding
        }

        // Check bottom edge
        if (top + rect.height > viewportHeight) {
            top = viewportHeight - rect.height - 5; // 5px padding
        }

        // Check left edge (unlikely but possible)
        if (left < 0) {
            left = 5;
        }

        // Check top edge
        if (top < 0) {
            top = 5;
        }

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }
}

export { Utils };
