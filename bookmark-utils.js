import { getSpaceTabs, spaceRequest } from './space-client.js';
import { LocalStorage } from './localstorage.js';
/**
 * Bookmark Utils - Consolidated bookmark operations for Arcify Chrome Extension
 * 
 * Purpose: Centralized utilities for all bookmark-related operations to eliminate code duplication
 * Key Functions: Arcify folder management, recursive traversal, URL matching, bookmark operations
 * Architecture: Static utility class with consistent error handling and Chrome API abstraction
 * 
 * Critical Notes:
 * - Reads the registered bookmark folder
 * - Provides unified recursive traversal with flexible options
 * - Centralizes URL matching logic with normalization
 * - Ensures consistent error handling across all bookmark operations
 * - Does not handle folder creation - defers to LocalStorage for that functionality
 */

import { Logger } from './logger.js';

export const BookmarkUtils = {

    async findArcifyFolder() {
        try {
            return await LocalStorage.getArcifyFolder();
        } catch (error) {
            Logger.error(Logger.context('Could not read the bookmark root.'), error);
            return null;
        }
    },

    /**
     * Recursively get all bookmarks from a folder and its subfolders
     * @param {string} folderId - ID of the folder to search
     * @param {Object} options - Options for filtering and processing
     * @param {boolean} options.includeTabIds - Whether to include tab IDs for matching tabs
     * @param {string} options.spaceId - Space ID to match tabs against (if includeTabIds is true)
     * @returns {Promise<Array>} Array of bookmark objects
     */
    async getBookmarksFromFolderRecursive(folderId, options = {}) {
        const { includeTabIds = false, spaceId = null } = options;
        const bookmarks = [];
        const items = await chrome.bookmarks.getChildren(folderId);

        // Get tabs once if needed for matching
        let tabs = [];
        if (includeTabIds && spaceId !== null) {
            tabs = await getSpaceTabs(spaceId);
        }

        for (const item of items) {
            if (item.url) {
                // This is a bookmark
                const bookmarkData = {
                    id: item.id,
                    title: item.title,
                    url: item.url
                };

                // Add tab ID if requested and found
                if (includeTabIds && tabs.length > 0) {
                    const matchingTab = tabs.find(t => t.url === item.url);
                    if (matchingTab) {
                        bookmarkData.tabId = matchingTab.id;
                    }
                }

                bookmarks.push(bookmarkData);
            } else {
                // This is a folder, recursively get bookmarks
                const subBookmarks = await this.getBookmarksFromFolderRecursive(item.id, options);
                bookmarks.push(...subBookmarks);
            }
        }

        return bookmarks;
    },

    /**
     * Open bookmark as active tab, handling all UI updates and data management
     * @param {Object} bookmarkData - Bookmark data object
     * @param {string} bookmarkData.url - Bookmark URL
     * @param {string} bookmarkData.title - Bookmark title
     * @param {string} bookmarkData.spaceName - Space name the bookmark belongs to
     * @param {string} targetSpaceId - Space ID to open the tab in
     * @param {HTMLElement} replaceElement - DOM element to replace with active tab element (optional)
     * @param {Object} context - Context object with required functions and data
     * @returns {Object} The created Chrome tab object
     */
    async openBookmarkAsTab(bookmarkData, targetSpaceId, replaceElement = null, context, isPinned) {
        const {
            spaces,
            activeSpaceId,
            currentWindow,
            saveSpaces,
            createTabElement,
            activateTabInDOM,
            Utils,
            persistSpaceTabOrder,
            getSpacePinNameDefaults
        } = context;

        Logger.log('[BookmarkUtils] Opening bookmark as tab:', bookmarkData.url, targetSpaceId);

        // Register a Space pin before its navigation so Air Traffic never treats it as a temporary tab.
        let newTab = await chrome.tabs.create({
            url: isPinned ? 'about:blank' : bookmarkData.url,
            active: true,
            windowId: currentWindow.id
        });
        if (isPinned) {
            try {
                const assigned = await spaceRequest('assign', { tabId: newTab.id, spaceId: targetSpaceId, pinned: true });
                if (!assigned.find(space => space.id === targetSpaceId)?.spaceBookmarks.includes(newTab.id)) {
                    throw new Error('The bookmark Space is no longer available.');
                }
                newTab = await chrome.tabs.update(newTab.id, { url: bookmarkData.url });
            } catch (error) {
                const remaining = await chrome.tabs.get(newTab.id).catch(() => null);
                if ((remaining?.pendingUrl || remaining?.url) === 'about:blank') {
                    await chrome.tabs.remove(newTab.id).catch(() => {});
                }
                throw error;
            }
        }

        // Keep the legacy title fallback for ordinary bookmarks. A named
        // Space pin gets its alias from its bookmark, not a tab-ID override.
        const nameDefaults = isPinned && bookmarkData.bookmarkId && getSpacePinNameDefaults
            ? await getSpacePinNameDefaults().catch(() => ({}))
            : {};
        const named = typeof nameDefaults[bookmarkData.bookmarkId] === 'string';
        if (!named && bookmarkData.title && newTab.title !== bookmarkData.title) {
            await Utils.setTabNameOverride(newTab.id, bookmarkData.url, bookmarkData.title);
        }

        if (isPinned) {
            // Track pinned URL/bookmarkId for Arc-like "Back to Pinned URL" behavior.
            if (Utils && typeof Utils.setPinnedTabState === 'function') {
                await Utils.setPinnedTabState(newTab.id, {
                    pinnedUrl: bookmarkData.url,
                    bookmarkId: bookmarkData.bookmarkId || null
                });
            }
        }

        // Pins are already assigned before navigation. Other bookmarks keep their existing assignment.
        if (!isPinned) await spaceRequest('assign', { tabId: newTab.id, spaceId: targetSpaceId });
        for (const space of spaces) {
            space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== newTab.id);
            space.temporaryTabs = space.temporaryTabs.filter(id => id !== newTab.id);
        }
        if (!isPinned) {
            spaces.find(s => s.id === targetSpaceId)?.temporaryTabs.push(newTab.id);
            await saveSpaces();
        }

        if (isPinned) {
            // Update space data - add to spaceBookmarks for pinned tabs
            const space = spaces.find(s => s.id === targetSpaceId);
            if (space) {
                if (!space.spaceBookmarks.includes(newTab.id)) {
                    space.spaceBookmarks.push(newTab.id);
                }
                saveSpaces();
            }
        }

        // Persist the bookmark section order independently of the native tab strip.
        if (typeof persistSpaceTabOrder === 'function') {
            await persistSpaceTabOrder(targetSpaceId, { source: 'arcify', movedTabId: newTab.id });
        }

        // Replace bookmark-only element with active tab element if provided
        if (replaceElement && createTabElement) {
            const activeTabData = {
                id: newTab.id,
                title: bookmarkData.title,
                url: bookmarkData.url,
                favIconUrl: newTab.favIconUrl,
                spaceName: bookmarkData.spaceName,
                pinnedUrl: bookmarkData.url,
                bookmarkId: bookmarkData.bookmarkId || null,
                pinAlias: named ? bookmarkData.title : ''
            };
            const activeTabElement = await createTabElement(activeTabData, true, false);
            activeTabElement.classList.add('active');
            replaceElement.replaceWith(activeTabElement);
        }

        // Ensure the tab is actually active
        await chrome.tabs.update(newTab.id, { active: true });

        // Visually activate the tab
        if (activateTabInDOM) {
            activateTabInDOM(newTab.id);
        }

        Logger.log('[BookmarkUtils] Successfully opened bookmark as tab:', newTab.id);
        return newTab;
    },

    /**
     * Match tabs with bookmarks in a folder and return tab IDs
     * Processes bookmark folder recursively and finds corresponding tabs
     * @param {Object} folder - Bookmark folder object
     * @param {string} spaceId - Space ID to match against
     * @param {Function} setTabNameOverride - Function to set tab name overrides
     * @param {Function} setPinnedTabState - Function to persist tab->bookmark binding
     * @param {Set} claimedTabIds - Tab IDs already bound to a bookmark in this run (shared across recursion)
     * @returns {Promise<Array>} Array of tab IDs that match bookmarks
     */
    async matchTabsWithBookmarks(folder, spaceId, setTabNameOverride = null, setPinnedTabState = null, claimedTabIds = null, getUrlKey = null, windowId = null) {
        const bookmarks = [];
        const [spaces, liveTabs, { pinnedTabStatesById = {} }] = await Promise.all([
            spaceRequest('get', { discoverBookmarks: false }),
            chrome.tabs.query({ pinned: false, ...(windowId === null ? {} : { windowId }) }),
            chrome.storage.local.get('pinnedTabStatesById')
        ]);
        const liveById = new Map(liveTabs.map(tab => [tab.id, tab]));
        const tabs = (spaces.find(space => space.id === spaceId)?.spaceBookmarks || [])
            .map(id => liveById.get(id)).filter(Boolean);
        const claimed = claimedTabIds || new Set();

        async function visit(folderId) {
            for (const item of await chrome.bookmarks.getChildren(folderId)) {
                if (!item.url) {
                    await visit(item.id);
                    continue;
                }

                // Legacy recovery is limited to already-pinned members without a binding.
                // Ordinary temporary tabs must never be promoted by a matching URL.
                const available = tabs.filter(tab => !claimed.has(tab.id));
                let tab = available.find(tab => pinnedTabStatesById[tab.id]?.bookmarkId === item.id)
                    || available.find(tab => tab.url === item.url && !pinnedTabStatesById[tab.id]?.bookmarkId);
                if (!tab && getUrlKey) {
                    const targetKey = getUrlKey(item.url);
                    tab = available.find(tab => !pinnedTabStatesById[tab.id]?.bookmarkId && getUrlKey(tab.url) === targetKey);
                }
                if (!tab) continue;

                claimed.add(tab.id);
                bookmarks.push(tab.id);
                if (item.title && item.title !== tab.title && setTabNameOverride) {
                    await setTabNameOverride(tab.id, tab.url, item.title, item.id);
                }
                if (setPinnedTabState) {
                    await setPinnedTabState(tab.id, { pinnedUrl: item.url, bookmarkId: item.id });
                }
            }
        }

        await visit(folder.id);
        return bookmarks;
    },

    /**
     * Check if a bookmark is under the Arcify folder hierarchy
     * @param {Object} bookmark - Bookmark object
     * @param {string} arcifyFolderId - Arcify folder ID
     * @returns {boolean} True if bookmark is under Arcify folder
     */
    isUnderArcifyFolder(bookmark, arcifyFolderId) {
        // Simple heuristic: check if the bookmark's parent path includes the Arcify folder
        // This is a simplified check - for a more robust solution, we'd need to traverse up the parent chain
        return bookmark.parentId && (bookmark.parentId === arcifyFolderId ||
            bookmark.parentId.startsWith(arcifyFolderId));
    },

    /**
     * Get bookmarks data with Arcify folder exclusion
     * @param {string} query - Search query
     * @returns {Promise<Array>} Filtered bookmarks array
     */
    async getBookmarksData(query) {
        try {
            const bookmarks = await chrome.bookmarks.search(query);

            // Get Arcify folder to exclude its bookmarks from regular bookmark search
            let arcifyFolderId = null;
            try {
                const arcifyFolder = await this.findArcifyFolder();
                if (arcifyFolder) {
                    arcifyFolderId = arcifyFolder.id;
                }
            } catch (error) {
                // Ignore error if Arcify folder doesn't exist
            }

            // Filter out Arcify bookmarks and keep only bookmarks with URLs
            const filteredBookmarks = bookmarks.filter(bookmark => {
                if (!bookmark.url) return false;

                // Exclude bookmarks that are under Arcify folder
                if (arcifyFolderId && this.isUnderArcifyFolder(bookmark, arcifyFolderId)) {
                    return false;
                }

                return true;
            });

            return filteredBookmarks;
        } catch (error) {
            Logger.error('[BookmarkUtils] Error getting bookmarks:', error);
            return [];
        }
    }
};
