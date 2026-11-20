import { isTrustedExtensionMessage } from './message-security.js';
import { withTabCloseMotion, withRemovedTabMotion } from './tab-close-motion.js';
import { updateTabAudioIndicator, updateWindowTabAudio, isAudioOnlyTabChange, TabAudioEvents } from './tab-audio.js';
import { TabDragPreview } from './tab-drag-preview.js';
import { TabPointerDrag, addDragListener, dispatchPointerDrag } from './tab-pointer-drag.js';
import { editSpacePin, getSpacePinNameDefaults, getSpaceBookmarkById, getSpaceBookmarkFolder, getSpaceBookmarkTree,
    isFolderInBookmarkRoot, removeSpacePin, restoreSpacePin, SPACE_PIN_NAME_DEFAULTS } from './space-bookmarks.js';
import { initSidebarTour } from './sidebar-tour.js';
import { setupSidebarPreviewHint } from './sidebar-preview-hint.js';
import { setupSpaceSwipe } from './sidebar-space-swipe.js';
import { CalendarPreview } from './calendar-preview.js';
import { calendarFavoriteUrl } from './calendar-config.js';
import { DEFAULT_SPACE_COLOR } from './space-colors.js';
import { invalidateSidebarFavicons, setSidebarFavicon, wrapSidebarFavicon } from './sidebar-favicon.js';
import { beginSidebarContextMenu } from './sidebar-context-menu.js';
/**
 * Sidebar - Main extension UI and tab/space management
 * 
 * Purpose: Implements Arc-like vertical tab organization with spaces
 * Key Functions: Space creation/management, tab organization, drag-and-drop, archived tabs
 * Architecture: Side panel UI backed by extension-owned space data
 * 
 * Critical Notes:
 * - Primary user interface for tab and space management
 * - Real-time sync with extension data and active tab changes
 * - Handles drag-and-drop for tab/space reorganization
 * - Manages archived tabs and auto-archive settings
 */

import { ChromeHelper } from './chromeHelper.js';
import { spaceRequest as requestSpace } from './space-client.js';
import { SpacePatchQueue } from './space-patch-queue.js';
import { RefreshCoordinator } from './refresh-coordinator.js';
import { EditSessionRegistry } from './edit-sessions.js';
import { setupCleanPreview, closeCleanPreview, reconcileCleanPreview, removeCleanCandidate } from './sidebar-clean.js';
import { setupCleanArchiveControls } from './sidebar-auto-archive.js';
import { favoriteRequest, getFavoriteDropTarget } from './native-favorites.js';
import { selectWindowSpaceTabs, mergeVisibleOrder, mergeCapturedTemporaryOrder, saveBookmarkOperation } from './sidebar-tabs.js';
import { ownerOf, resolveDefaultSpace } from './space-store.js';
import { canCreateFolder, canMoveFolder, createFolder } from './folder-policy.js';
import { loadFolderCollapsed, saveFolderCollapsed } from './folder-state.js';
import { projectCollapsedFolder, removeProjectedAnchor, updateFolderPlaceholder } from './sidebar-folder-projection.js';
import { bookmarkOrderBaselines, bookmarkParentIdForContent, getFlattenedPinnedSectionTabIds, getTempSectionTabIds,
    makeBookmarkDropOperation, uniqPreserveOrder } from './sidebar-drop-order.js';
import { getContextTabIds, getTabSelectionRange } from './tab-selection.js';
import { LocalStorage } from './localstorage.js';
import { Utils } from './utils.js';
import {
    setupDOMElements,
    setupSpaceColorPicker,
    applySpaceColor,
    showSpaceNameInput,
    activateTabInDOM,
    activateSpaceInDOM,
    showTabContextMenu,
    showArchivedTabsPopup,
    setupQuickPinListener,
    getDragAfterElement,
    getSpaceElement,
    getContainers,
    getTabElement,
    clearAllActiveStates,
    hideAllDropIndicators,
    showDropIndicator,
    getDropPosition,
    handleEmptyContainerDrop,
    showUndoToast
} from './domManager.js';
import { BookmarkUtils } from './bookmark-utils.js';
import { Logger } from './logger.js';
import { MOUSE_BUTTON, CSS_CLASSES, TIMING } from './constants.js';

// DOM Elements
const spacesList = document.getElementById('spacesList');
const spaceSwitcher = document.getElementById('spaceSwitcher');
const addSpaceBtn = document.getElementById('addSpaceBtn');
const spaceTemplate = document.getElementById('spaceTemplate');

// Global state
let spaces = [];
let activeSpaceId = null;
let previousSpaceId = null;
let isCreatingSpace = false;
let isOpeningBookmark = false;
let isDraggingTab = false;
let tabDropCommitting = false;
let draggedSpaceSwitcherButton = null;
let pendingMutationCount = 0;
let currentWindow = null;
let calendarPreview;
let spaceSwipe;
let defaultSpaceName = 'Home';
let showAllOpenTabsInCollapsedFolders = false;
let activeChromeTabId = null;
const selectedTabIds = new Set();
let selectionAnchorTabId = null;
let draggingTabIds = [];
const tabDragPreview = new TabDragPreview(document, () => {
    clearFolderOpenTimer();
    endSpaceDragPreview();
    hideAllDropIndicators();
    document.querySelectorAll('.multi-dragging').forEach(row => row.classList.remove('multi-dragging'));
    tabPointerDrag.cancel();
});
const tabPointerDrag = new TabPointerDrag(document, tabDragPreview);

function getSelectableTabElements() {
    const activeSpace = document.querySelector('.space.active');
    return activeSpace
        ? [...activeSpace.querySelectorAll('.tab[data-tab-id]:not(.bookmark-only)')]
        : [];
}

function syncTabSelectionUI() {
    document.querySelectorAll('.tab[data-tab-id]').forEach(element => {
        const selected = selectedTabIds.has(Number(element.dataset.tabId));
        element.classList.toggle('multi-selected', selected);
        element.setAttribute('aria-selected', String(selected));
    });
}

function getCurrentSelectableTabId() {
    const activeElement = document.querySelector('.space.active .tab.active[data-tab-id]:not(.bookmark-only)');
    if (activeElement) return Number(activeElement.dataset.tabId);
    const activeOwner = activeChromeTabId ? ownerOf(spaces, activeChromeTabId) : null;
    return activeOwner?.id === activeSpaceId ? activeChromeTabId : null;
}

function clearTabSelection({ keepAnchor = false } = {}) {
    selectedTabIds.clear();
    const currentTabId = getCurrentSelectableTabId();
    if (currentTabId) selectedTabIds.add(currentTabId);
    if (!keepAnchor) selectionAnchorTabId = currentTabId;
    syncTabSelectionUI();
}

function selectOnlyTab(tabId) {
    selectedTabIds.clear();
    selectedTabIds.add(tabId);
    selectionAnchorTabId = tabId;
    syncTabSelectionUI();
}

function selectTabRange(targetTabId) {
    const orderedIds = getSelectableTabElements().map(element => Number(element.dataset.tabId));
    const anchorTabId = selectionAnchorTabId || getCurrentSelectableTabId();
    const range = getTabSelectionRange(orderedIds, anchorTabId, targetTabId);
    selectedTabIds.clear();
    range.forEach(id => selectedTabIds.add(id));
    if (selectionAnchorTabId == null) selectionAnchorTabId = anchorTabId || targetTabId;
    syncTabSelectionUI();
}

function getOrderedTabElementsById(tabIds) {
    const ids = new Set(tabIds);
    return getSelectableTabElements().filter(element => ids.has(Number(element.dataset.tabId)));
}
function spaceAtOffset(offset) {
    const currentIndex = spaces.findIndex(space => space.id === activeSpaceId);
    if (currentIndex === -1 || (offset && spaces.length < 2)) return;
    return spaces[(currentIndex + offset + spaces.length) % spaces.length];
}

function disposeEditorsInElement(element) {
    if (!element) return;
    const dispose = node => {
        if (node.matches?.('.tab[data-tab-id]')) editorSessions?.dispose('tab', node.dataset.tabId);
        if (node.matches?.('.folder[data-bookmark-id]')) editorSessions?.dispose('folder', node.dataset.bookmarkId);
        if (node.matches?.('.space[data-space-id]')) editorSessions?.dispose('space', node.dataset.spaceId);
    };
    dispose(element);
    element.querySelectorAll?.('.tab[data-tab-id], .folder[data-bookmark-id], .space[data-space-id]').forEach(dispose);
}

chrome.runtime.onMessage.addListener((message, sender) => {
    if (!isTrustedExtensionMessage(message, sender, chrome)) return;
    if (message.type === 'spaceStoreStatus') {
        setSpaceStoreStatus(message.code);
        return;
    }
    if (message.action !== 'arcifyBookmarksChanged') return;
    scheduleBookmarkRefresh();
});

function setSpaceStoreStatus(code) {
    const notice = document.getElementById('spaceStoreStatus');
    notice.textContent = code === 'bookmark_folder_unavailable'
        ? 'Chrome could not access the space bookmark folders. Try again or reopen the sidebar.'
        : code === 'space_storage_unavailable'
            ? 'Chrome could not save or read your spaces. Try again or reopen the sidebar.'
            : '';
    notice.hidden = !notice.textContent;
}

function showSpaceStoreError(error, fallback = 'space_storage_unavailable') {
    if (error?.code === 'space_drop_conflict' || error?.code === 'default_space_protected') return;
    let code = fallback;
    if (error?.code === 'bookmark_folder_unavailable' || error?.code === 'space_storage_unavailable') {
        code = error.code;
    } else if (/quota/i.test(error?.message)) {
        code = 'space_storage_unavailable';
    }
    setSpaceStoreStatus(code);
}

async function spaceRequest(action, payload) {
    try {
        return await requestSpace(action, payload);
    } catch (error) {
        showSpaceStoreError(error);
        throw error;
    }
}

async function getSidebarBookmarkRoot() {
    try {
        return await LocalStorage.getOrCreateArcifyFolder();
    } catch (error) {
        showSpaceStoreError(error, 'bookmark_folder_unavailable');
        throw error;
    }
}

function scheduleBookmarkRefresh() {
    refreshCoordinator.invalidateBookmarks();
}

async function savePinAlias(tab, tabElement, name) {
    const binding = await Utils.getPinnedTabState(tab.id);
    if (!binding?.bookmarkId || String(binding.bookmarkId) !== tabElement.dataset.bookmarkId) {
        throw new Error('The favorite binding is no longer valid for this tab.');
    }
    const space = ownerOf(spaces, tab.id);
    const alias = await editSpacePin(space, binding.bookmarkId, (bookmark, original) => {
        const automaticTitle = isAwayFromPin(tab.url, bookmark.url)
            ? original ?? bookmark.title
            : tab.title || original || bookmark.title;
        return { changes: { title: name || automaticTitle }, nameDefault: name ? original ?? bookmark.title : null };
    });
    tabElement.dataset.pinAlias = alias;
    if (!name) await Utils.removeTabNameOverride(tab.id)
        .catch(error => Logger.warn('Could not clear the tab’s previous title override.', error));
}


async function replaceBookmarkUrlWithCurrentUrl(tab, tabElement) {
    if (!tab?.id) return;

    // Always prefer the live tab URL (the `tab` object captured by the UI can be stale).
    let liveTab = null;
    try {
        liveTab = await chrome.tabs.get(tab.id);
    } catch (e) {
        // We'll fall back to dataset/tab url below.
    }

    const newUrl = liveTab?.url || tabElement?.dataset?.url || tab?.url || null;
    if (!newUrl) {
        Logger.warn('[Arcify] Replace bookmark URL failed: missing current tab URL', { tabId: tab.id });
        return;
    }
    const newTitle = liveTab?.title || tab?.title || null;

    const stored = await Utils.getPinnedTabState(tab.id);
    const bookmarkId = tabElement?.dataset?.bookmarkId || stored?.bookmarkId;
    const pinnedUrl = tabElement?.dataset?.pinnedUrl || stored?.pinnedUrl;

    const resolvedBookmarkId = bookmarkId;

    if (!resolvedBookmarkId) {
        Logger.warn('[Arcify] Cannot replace bookmark URL: missing bookmarkId and unable to resolve.', {
            tabId: tab.id,
            pinnedUrl,
            dataset: tabElement?.dataset
        });
        return;
    }

    let alias;
    try {
        const space = ownerOf(spaces, tab.id);
        alias = await editSpacePin(space, resolvedBookmarkId, (_bookmark, original) => ({
            changes: { url: newUrl, ...(original === null && newTitle && { title: newTitle }) },
            nameDefault: original === null ? null : newTitle || original,
        }));
    } catch (e) {
        Logger.error('[Arcify] chrome.bookmarks.update failed', { bookmarkId: resolvedBookmarkId, newUrl, error: e });
        return;
    }

    await Utils.setPinnedTabState(tab.id, { bookmarkId: resolvedBookmarkId, pinnedUrl: newUrl });
    if (!alias && newTitle) {
        // Keep the automatic bookmark fallback for an unnamed pin.
        await Utils.setTabNameOverride(tab.id, newUrl, newTitle);
    }

    if (tabElement) {
        tabElement.dataset.pinnedUrl = newUrl;
        tabElement.dataset.url = newUrl;
        tabElement.dataset.pinAlias = alias;
        // Tab is now pinned to current URL; "back to pinned" should no longer be available.
        const favicon = tabElement.querySelector('.tab-favicon') || tabElement.querySelector('img');
        if (favicon) {
            favicon.classList.remove('pinned-back');
            favicon.title = '';
        }
        const slash = tabElement.querySelector('.tab-url-changed-slash');
        if (slash) slash.classList.remove('visible');

        renderLiveTabLabel(tabElement, { url: newUrl, title: newTitle || tab.title });
    }
}

// Function to apply color overrides from settings
async function applyColorOverrides() {
    try {
        const settings = await Utils.getSettings();
        Logger.log('Applying color overrides, settings:', settings);

        const root = document.documentElement;

        // Clear any existing overrides first
        const colorNames = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];
        colorNames.forEach(colorName => {
            root.style.removeProperty(`--user-chrome-${colorName}-color`);
        });

        // Apply new overrides if they exist
        if (settings.colorOverrides && Object.keys(settings.colorOverrides).length > 0) {
            Logger.log('Found color overrides:', settings.colorOverrides);
            Object.keys(settings.colorOverrides).forEach(colorName => {
                const colorValue = settings.colorOverrides[colorName];
                if (colorValue) {
                    root.style.setProperty(`--user-chrome-${colorName}-color`, colorValue);
                    Logger.log(`Applied color override: --user-chrome-${colorName}-color = ${colorValue}`);
                }
            });
        } else {
            Logger.log('No color overrides found in settings');
        }

        // Re-apply colors to all existing spaces
        reapplySpaceColors();
    } catch (error) {
        Logger.error('Error applying color overrides:', error);
    }
}

// Function to re-apply colors to the active space
function reapplySpaceColors() {
    const sidebarContainer = document.getElementById('sidebar-container');
    if (!sidebarContainer || !activeSpaceId || spaces.length === 0) return;

    const activeSpace = spaces.find(space => space.id === activeSpaceId);
    if (activeSpace) applySpaceColor(activeSpace.color, { refresh: true });
}

async function changeFavorite(action, favoriteId) {
    try {
        await favoriteRequest(action, { windowId: currentWindow.id, favoriteId });
    } catch (error) {
        Logger.warn(`Could not ${action} Favorite:`, error);
    }
    await updatePinnedFavicons();
}

function createFavoriteTile(favoriteId) {
    const tile = document.createElement('div');
    tile.className = 'favorite-tile';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pinned-favicon';
    button.dataset.favoriteId = favoriteId;
    button.draggable = true;
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    button.appendChild(wrapSidebarFavicon(img));

    button.addEventListener('click', () => changeFavorite('open', favoriteId));
    button.addEventListener('dblclick', async () => {
        if (!button.hasAttribute('data-tab-id')) return;
        try {
            await favoriteRequest('reset', { tabId: Number(button.dataset.tabId) });
        } catch (error) {
            Logger.warn('Could not reset Favorite:', error);
        }
    });
    addDragListener(button, 'dragstart', () => button.classList.add('dragging'));
    addDragListener(button, 'dragend', () => button.classList.remove('dragging'));

    tile.append(button);
    return tile;
}

const tabAudioEvents = new TabAudioEvents();
let favoriteRead = 0;
async function updatePinnedFavicons() {
    const revision = ++favoriteRead;
    const pinnedFavicons = document.getElementById('pinnedFavicons');
    const pinnedTabs = await tabAudioEvents.read(() => favoriteRequest('get', { windowId: currentWindow.id }));
    if (revision !== favoriteRead) return;
    pinnedFavicons.style.setProperty('--favorite-columns', Math.max(1, Math.min(4, pinnedTabs.length)));
    pinnedFavicons.classList.toggle('empty', pinnedTabs.length === 0);

    const existing = new Map([...pinnedFavicons.querySelectorAll('.pinned-favicon')].map(button =>
        [button.dataset.favoriteId, button.closest('.favorite-tile')]));
    let previous;
    for (const tab of pinnedTabs) {
        const tile = existing.get(tab.favoriteId) || createFavoriteTile(tab.favoriteId);
        existing.delete(tab.favoriteId);
        const next = previous ? previous.nextElementSibling : pinnedFavicons.querySelector('.favorite-tile');
        if (next !== tile) pinnedFavicons.insertBefore(tile, next);
        previous = tile;
        const existingElement = tile.querySelector('.pinned-favicon');
        const url = tab.baseUrl || tab.url;
        const name = tab.title || url;
        if (tab.closed) delete existingElement.dataset.tabId;
        else existingElement.dataset.tabId = tab.id;
        existingElement.dataset.pinnedUrl = url;
        existingElement.dataset.audioBaseTitle = tab.closed
            ? `${name}\n${url}\nOpen saved Favorite`
            : `${name}\n${url}\nDouble-click to return to saved URL`;
        let remove = tile.querySelector('.favorite-remove');
        if (tab.closed) {
            if (!remove) {
                remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'favorite-remove';
                remove.textContent = '×';
                remove.addEventListener('click', () => changeFavorite('remove', tab.favoriteId));
                tile.append(remove);
            }
            remove.title = `Remove ${name} from Favorites`;
            remove.setAttribute('aria-label', remove.title);
        } else if (remove) {
            if (document.activeElement === remove) existingElement.focus({ preventScroll: true });
            remove.remove();
        }
        if (__PRISMARC_INCLUDE_CALENDAR__) {
            const calendarUrl = calendarPreview && calendarFavoriteUrl(existingElement.dataset.pinnedUrl);
            if (calendarUrl) {
                existingElement.dataset.calendarFavorite = calendarUrl.href;
                existingElement.setAttribute('aria-haspopup', 'dialog');
                existingElement.setAttribute('aria-keyshortcuts', 'ArrowDown');
                existingElement.setAttribute('aria-controls', 'calendarPreview');
                if (!existingElement.hasAttribute('aria-expanded')) existingElement.setAttribute('aria-expanded', 'false');
            } else if (existingElement.hasAttribute('data-calendar-favorite')) {
                delete existingElement.dataset.calendarFavorite;
                for (const name of ['aria-haspopup', 'aria-keyshortcuts', 'aria-controls', 'aria-expanded']) {
                    existingElement.removeAttribute(name);
                }
            }
        }
        updateTabAudioIndicator(existingElement, tab, { live: !tab.closed });
        existingElement.classList.toggle('active', Boolean(tab.active));
        setSidebarFavicon(existingElement.querySelector('img'), url, '96');
    }
    const removedFocus = [...existing.values()].some(tile => tile.contains(document.activeElement));
    for (const tile of existing.values()) tile.remove();
    if (removedFocus) {
        const next = pinnedFavicons.querySelector('.pinned-favicon') || document.getElementById('quickSwitcherBtn');
        next?.focus({ preventScroll: true });
    }
    if (__PRISMARC_INCLUDE_CALENDAR__) calendarPreview?.position();

    // Show/hide placeholder based on whether there are pinned tabs
    const placeholderContainer = pinnedFavicons.querySelector('.pinned-placeholder-container');
    if (placeholderContainer) {
        if (pinnedTabs.length === 0) {
            placeholderContainer.style.display = 'block';
        } else {
            placeholderContainer.style.display = 'none';
        }
    }

    // Add drag and drop event listeners ONCE. updatePinnedFavicons() is called from many
    // handlers; re-adding these container listeners every call leaked duplicate handlers
    // that fired repeatedly (B8). Guard on a dataset flag so they bind exactly once.
    if (!pinnedFavicons.dataset.dragListenersBound) {
        pinnedFavicons.dataset.dragListenersBound = 'true';
    addDragListener(pinnedFavicons, 'dragover', e => {
        e.preventDefault();
        e.currentTarget.classList.add('drag-over');

        // Show drop indicator for horizontal favicons
        const draggingElement = document.querySelector('.dragging');
        if (draggingElement) {
            const afterElement = getFavoriteDropTarget(pinnedFavicons, e.clientX, e.clientY);
            if (afterElement) {
                // Check if this is a placeholder (empty container)
                if (afterElement.classList.contains('pinned-placeholder-container')) {
                    // Show visual feedback on the placeholder itself
                    afterElement.classList.add('drag-over');
                    hideAllDropIndicators(); // Don't show traditional indicators for placeholders
                } else {
                    // Show traditional drop indicators for actual favicons
                    const position = getDropPosition(afterElement, e.clientX, e.clientY, true);
                    showDropIndicator(afterElement, position, true);
                    // Remove any placeholder drag-over state
                    const placeholder = pinnedFavicons.querySelector('.pinned-placeholder-container');
                    if (placeholder) placeholder.classList.remove('drag-over');
                }
            } else {
                hideAllDropIndicators();
                // Remove any placeholder drag-over state
                const placeholder = pinnedFavicons.querySelector('.pinned-placeholder-container');
                if (placeholder) placeholder.classList.remove('drag-over');
            }
        }
    });

    addDragListener(pinnedFavicons, 'dragleave', e => {
        e.preventDefault();
        e.currentTarget.classList.remove('drag-over');
        // Hide indicators when leaving the pinned favicons area
        if (!pinnedFavicons.contains(e.relatedTarget)) {
            hideAllDropIndicators();
            // Remove any placeholder drag-over state
            const placeholder = pinnedFavicons.querySelector('.pinned-placeholder-container');
            if (placeholder) placeholder.classList.remove('drag-over');
        }
    });

    addDragListener(pinnedFavicons, 'drop', async e => {
        e.preventDefault();
        e.currentTarget.classList.remove('drag-over');
        hideAllDropIndicators(); // Clean up indicators on drop
        // Remove any placeholder drag-over state
        const placeholder = pinnedFavicons.querySelector('.pinned-placeholder-container');
        if (placeholder) placeholder.classList.remove('drag-over');
        const draggingElement = document.querySelector('.dragging');
        if (!draggingElement?.dataset.favoriteId && !draggingElement?.dataset.tabId) return;
        const target = getFavoriteDropTarget(pinnedFavicons, e.clientX, e.clientY);
        const targetId = target?.dataset.favoriteId;
        const after = targetId && getDropPosition(target, e.clientX, e.clientY, true) === 'right';
        const windowId = currentWindow.id;
        let favoriteIds;
        let moving;
        if (draggingElement.dataset.favoriteId) {
            favoriteIds = [...pinnedFavicons.querySelectorAll('.pinned-favicon')].map(el => el.dataset.favoriteId);
            moving = [draggingElement.dataset.favoriteId];
        } else {
            const tabIds = draggingTabIds.length > 1 ? [...draggingTabIds] : [Number(draggingElement.dataset.tabId)];
            try {
                const cards = await favoriteRequest('pin', { tabIds, windowId });
                favoriteIds = cards.map(card => card.favoriteId);
                moving = tabIds.map(id => cards.find(card => card.id === id)?.favoriteId).filter(Boolean);
            } catch (error) {
                alert(error.message);
                return;
            }
        }
        const order = favoriteIds.filter(id => !moving.includes(id));
        const index = order.indexOf(targetId);
        order.splice(index < 0 ? order.length : index + Number(after), 0, ...moving);
        try {
            await favoriteRequest('reorder', { windowId, favoriteIds: order });
        } catch (error) {
            Logger.warn('Could not reorder Favorites:', error);
        }
        await updatePinnedFavicons();
    });
    } // end bind-once guard for pinnedFavicons drag listeners
}

// Utility function to activate a pinned tab by URL (reuses existing bookmark opening logic)
async function activatePinnedTabByURL(bookmarkUrl, targetSpaceId, spaceName, bookmarkId = null) {
    Logger.log('[PinnedTabActivator] Activating pinned tab:', bookmarkUrl, targetSpaceId, spaceName);

    try {
        const bindings = await Utils.getPinnedTabStates();
        const tabs = await getOwnedTabs(targetSpaceId);
        const existingTab = bookmarkId
            ? tabs.find(tab => String(bindings[tab.id]?.bookmarkId) === String(bookmarkId))
            : null;

        if (existingTab) {
            Logger.log('[PinnedTabActivator] Found existing tab, switching to it:', existingTab.id);
            // Tab already exists, just switch to it and highlight
            await Utils.focusTab(existingTab.id);
            activateTabInDOM(existingTab.id);

            // Store last active tab for the space
            const space = ownerOf(spaces, existingTab.id);
            if (space) {
                space.lastTab = existingTab.id;
                saveSpaces();
            }
        } else {
            Logger.log('[PinnedTabActivator] No existing tab found, opening bookmark');
            const spaceElement = document.querySelector(`[data-space-id="${targetSpaceId}"]`);
            const candidates = [...(spaceElement?.querySelectorAll('.bookmark-only') || [])].filter(el =>
                bookmarkId ? String(el.dataset.bookmarkId) === String(bookmarkId) : el.dataset.url === bookmarkUrl);
            if (candidates.length !== 1) throw new Error('Favorite activation is ambiguous without a bookmark identity.');
            const existingBookmarkElement = candidates[0];
            const space = spaces.find(item => item.id === targetSpaceId);
            const bookmark = await getSpaceBookmarkById(space, existingBookmarkElement.dataset.bookmarkId);
            if (!bookmark) throw new Error('Favorite no longer belongs to this space.');

            // Prepare bookmark data for opening
            const bookmarkData = {
                url: bookmarkUrl,
                title: bookmark.title || 'Bookmark',
                spaceName: spaceName,
                pinnedUrl: bookmarkUrl,
                bookmarkId: bookmark.id
            };

            // Prepare context for BookmarkUtils
            const context = {
                spaces,
                activeSpaceId,
                currentWindow,
                saveSpaces,
                createTabElement,
                activateTabInDOM,
                Utils,
                persistSpaceTabOrder,
                getSpacePinNameDefaults
            };

            // Use shared bookmark opening logic
            isOpeningBookmark = true;
            try {
                await BookmarkUtils.openBookmarkAsTab(bookmarkData, targetSpaceId, existingBookmarkElement, context, /*isPinned=*/true);
            } finally {
                isOpeningBookmark = false;
                refreshCoordinator.schedule();
            }
        }
    } catch (error) {
        Logger.error("[PinnedTabActivator] Error activating pinned tab:", error);
        isOpeningBookmark = false;
    }
}

// Initialize the sidebar when the DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    Logger.log('DOM loaded, initializing sidebar...');
    document.getElementById('quickSwitcherBtn').addEventListener('click', async () => {
        try {
            const invokingWindow = await chrome.windows.getCurrent();
            const response = await chrome.runtime.sendMessage({ action: 'openQuickSwitcher', windowId: invokingWindow.id });
            if (!response?.success) throw new Error(response?.error || 'Could not open search');
        } catch (error) {
            Logger.error('[Quick Switcher] Could not open search:', error);
        }
    });
    const refreshSearchShortcut = async () => {
        try {
            const commands = await chrome.commands.getAll();
            const shortcut = commands.find(command => command.name === 'mockQuickSwitcher')?.shortcut;
            document.getElementById('quickSwitcherTooltip').textContent = shortcut ? `Quick Switcher · ${shortcut}` : 'Quick Switcher';
        } catch (error) {
            Logger.error('[Quick Switcher] Could not read shortcut:', error);
        }
    };
    refreshSearchShortcut();
    window.addEventListener('focus', refreshSearchShortcut);
    await applyColorOverrides();

    // Listen for storage changes to re-apply colors when they're updated
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes.defaultSpaceName) {
            defaultSpaceName = changes.defaultSpaceName.newValue || 'Home';
            updateDeleteSpaceButtons();
        }
        if (areaName === 'local' && changes[SPACE_PIN_NAME_DEFAULTS]) scheduleBookmarkRefresh();
        if (areaName === 'local' && changes.colorOverrides) {
            Logger.log('Color overrides changed, re-applying...');
            applyColorOverrides();
        }

        // Re-render active space when tab order inversion setting changes
        if (areaName === 'local' && changes.invertTabOrder) {
            Logger.log('invertTabOrder changed, refreshing active space UI...');
            if (refreshActiveSpaceUITimeout) clearTimeout(refreshActiveSpaceUITimeout);
            refreshActiveSpaceUITimeout = setTimeout(() => {
                refreshActiveSpaceUITimeout = null;
                refreshActiveSpaceUI();
            }, 50);
        }

        if (areaName === 'local' && changes.showAllOpenTabsInCollapsedFolders) {
            showAllOpenTabsInCollapsedFolders = Boolean(changes.showAllOpenTabsInCollapsedFolders.newValue);
            spacesList.querySelectorAll('.folder').forEach(syncCollapsedFolderTabs);
        }
    });

    try {
        await initSidebar();
    } catch (error) {
        showSpaceStoreError(error);
        Logger.error(Logger.context('Sidebar initialization failed.'), error);
        return;
    }
    setupSidebarPreviewHint(currentWindow).catch(() => {});
    document.addEventListener('click', event => {
        if (event.target.closest('.tab, #tab-context-menu')) return;
        clearTabSelection();
    });
    await updatePinnedFavicons(); // Initial load before taking the tour baseline
    initSidebarTour().catch(error => Logger.error("Tour initialization failed:", error));

    // Add Chrome tab event listeners
    chrome.tabs.onCreated.addListener(handleTabCreated);
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        handleTabUpdate(tabId, changeInfo, tab);
        if ((tab.pinned || changeInfo.pinned !== undefined) && !isAudioOnlyTabChange(changeInfo)) updatePinnedFavicons();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        const snapshot = changes.nativeFavoriteSnapshot;
        if (area !== 'local' || !snapshot) return;
        // Native tab events already refresh live Favorites. A closed tile can be
        // removed or reordered from another sidebar without any native event.
        const closed = records => JSON.stringify((records || []).filter(record => record.closed));
        if (closed(snapshot.oldValue) !== closed(snapshot.newValue)) updatePinnedFavicons();
    });
    chrome.tabs.onRemoved.addListener(handleTabRemove);
    const refreshWindowTabs = async (_tabId, info) => {
        if (info.oldWindowId === currentWindow?.id) tabAudioEvents.forget(_tabId);
        if (info.newWindowId === currentWindow?.id || info.oldWindowId === currentWindow?.id) {
            await updatePinnedFavicons();
            await refreshActiveSpaceUI();
        }
    };
    chrome.tabs.onAttached.addListener(refreshWindowTabs);
    chrome.tabs.onDetached.addListener(refreshWindowTabs);
    chrome.tabs.onMoved.addListener((_tabId, info) => {
        if (info.windowId === currentWindow?.id) updatePinnedFavicons();
    });
    chrome.tabs.onActivated.addListener(handleTabActivated);
    // Setup Quick Pin listener
    setupQuickPinListener(moveTabToSpace, moveTabToPinned, moveTabToTemp, activeSpaceId, setActiveSpace, activatePinnedTabByURL);

    // Tab navigation listener
    // Add event listener for placeholder close button
    const closePlaceholderBtn = document.querySelector('.placeholder-close-btn');
    const placeholderContainer = document.querySelector('.pinned-placeholder-container');
    if (closePlaceholderBtn && placeholderContainer) {
        closePlaceholderBtn.addEventListener('click', () => {
            placeholderContainer.style.display = 'none';
        });
    }

    spaceSwitcher.addEventListener('mouseup', async (event) => {
        if (event.button !== MOUSE_BUTTON.BACK && event.button !== MOUSE_BUTTON.FORWARD) {
            return;
        }

        event.preventDefault();
        const space = spaceAtOffset(event.button === MOUSE_BUTTON.BACK ? -1 : 1);
        if (space) await setActiveSpace(space.id);
    });

    spaceSwipe = setupSpaceSwipe(document.getElementById('sidebar-container'), {
        getSpace: spaceAtOffset,
        canSwipe: () => !isDraggingTab && !draggedSpaceSwitcherButton && !spaceDragPreview &&
            pendingMutationCount === 0 && !editorSessions.isActive(),
        activate: spaceId => setActiveSpace(spaceId, true, { source: 'swipe' }),
        onError: error => Logger.warn('Could not switch spaces with a swipe:', error),
    });
});

const spaceSaveQueue = new SpacePatchQueue(
    (before, after, condition) => spaceRequest('patch', { before, after, ...condition }),
    async error => {
        const current = await spaceRequest('get');
        await adoptStoredSpaces(current);
        showSpaceStoreError(error);
        return current;
    }
);
let pendingSpaceSaves = Promise.resolve();
let pendingSaveCount = 0;
let sidebarReady = false;
let editorSessions;
const refreshCoordinator = new RefreshCoordinator({
    readSpaces: async () => {
        await pendingSpaceSaves;
        return spaceRequest('get');
    },
    adoptSpaces: next => adoptStoredSpaces(next, { render: false }),
    render: async () => {
        await activateSpaceInDOM(activeSpaceId, spaces, updateSpaceSwitcher);
        return refreshActiveSpaceUI();
    },
    isBusy: () => !sidebarReady || isDraggingTab || isOpeningBookmark || pendingSaveCount > 0 || pendingMutationCount > 0 || editorSessions?.isActive(),
    onError: error => Logger.warn('Could not refresh external changes:', error)
});
editorSessions = new EditSessionRegistry(() => refreshCoordinator.schedule());

async function adoptStoredSpaces(next, { render = true } = {}) {
    if (editorSessions.isActive()) {
        refreshCoordinator.invalidateSpaces();
        return { needsRender: false, completed: false };
    }
    if (render && pendingMutationCount > 0) {
        render = false;
        refreshCoordinator.invalidateSpaces();
    }
    const projection = list => JSON.stringify(list.map(({ id, name, color, bookmarkFolderId, spaceBookmarks, temporaryTabs }) =>
        ({ id, name, color, bookmarkFolderId, spaceBookmarks, temporaryTabs })));
    const needsRender = projection(spaces) !== projection(next);
    const old = spaces;
    const oldMetadata = new Map(old.map(s => [s.id, { name: s.name, color: s.color }]));
    spaces = next.map(space => {
        const existing = old.find(s => s.id === space.id);
        return existing ? Object.assign(existing, structuredClone(space)) : structuredClone(space);
    });
    spaceSaveQueue.reset(next);
    for (const space of old) {
        if (!spaces.some(s => s.id === space.id)) {
            const element = getSpaceElement(space.id);
            if (space.id === activeSpaceId) closeCleanPreview();
            disposeEditorsInElement(element);
            element?.remove();
        }
    }
    for (const space of spaces) {
        // Remove old projections immediately when another panel moves or closes a tab.
        // Newly added rows are rendered when the destination space is shown.
        const owned = new Set([...space.spaceBookmarks, ...space.temporaryTabs]);
        getSpaceElement(space.id)?.querySelectorAll('.tab[data-tab-id]').forEach(element => {
            if (!owned.has(Number(element.dataset.tabId))) {
                disposeEditorsInElement(element);
                element.remove();
            }
        });
        const previous = oldMetadata.get(space.id);
        if (!previous || previous.name !== space.name || previous.color !== space.color) {
            const element = getSpaceElement(space.id);
            if (space.id === activeSpaceId) closeCleanPreview();
            disposeEditorsInElement(element);
            element?.remove();
            createSpaceElement(space);
        }
    }
    updateDeleteSpaceButtons();
    if (!spaces.some(s => s.id === activeSpaceId)) {
        spaceSwipe?.cancel();
        activeSpaceId = spaces[0]?.id;
    }
    if (needsRender && render) {
        await activateSpaceInDOM(activeSpaceId, spaces, updateSpaceSwitcher);
        await refreshActiveSpaceUI();
    }
    return { needsRender, completed: true };
}

async function initSidebar() {
    const settings = await Utils.getSettings();
    defaultSpaceName = settings.defaultSpaceName || 'Home';
    showAllOpenTabsInCollapsedFolders = Boolean(settings.showAllOpenTabsInCollapsedFolders);
    currentWindow = await chrome.windows.getCurrent({ populate: false });
    if (__PRISMARC_INCLUDE_CALENDAR__ && !currentWindow.incognito) {
        const favorites = document.getElementById('pinnedFavicons');
        calendarPreview = new CalendarPreview(favorites, async (url, reuse = false) => {
            if (reuse) {
                const page = url.split('?')[0];
                const tabs = await chrome.tabs.query({ windowId: currentWindow.id });
                const existing = tabs.find(tab => (tab.pendingUrl || tab.url)?.split('?')[0] === page);
                if (existing) {
                    const update = { active: true };
                    if (url !== page && (existing.pendingUrl || existing.url) !== url) update.url = url;
                    return chrome.tabs.update(existing.id, update);
                }
            }
            return chrome.tabs.create({ windowId: currentWindow.id, url });
        });
    }
    spaces = await spaceRequest('get');
    spaceSaveQueue.reset(spaces);
    const allTabs = await chrome.tabs.query({});
    await Utils.prunePinnedTabStates(allTabs.map(t => t.id));
    const pinNameDefaults = await getSpacePinNameDefaults();
    const restoreTabTitle = (tabId, url, name, bookmarkId) => {
        if (typeof pinNameDefaults[bookmarkId] !== 'string') return Utils.setTabNameOverride(tabId, url, name);
    };
    // Restore bookmark bindings using only this space's owned tabs.
    for (const space of spaces) {
        try {
            const folder = await getSpaceBookmarkFolder(space);
            const bound = await BookmarkUtils.matchTabsWithBookmarks(folder, space.id,
                restoreTabTitle, Utils.setPinnedTabState.bind(Utils), null, Utils.getPinnedUrlKey.bind(Utils), currentWindow.id);
            const previousPins = space.spaceBookmarks;
            const windowTabIds = new Set(allTabs.filter(t => t.windowId === currentWindow.id).map(t => t.id));
            space.spaceBookmarks = [...new Set([...previousPins.filter(id => !windowTabIds.has(id)), ...bound])];
            space.temporaryTabs = [...new Set([...space.temporaryTabs, ...previousPins])].filter(id => !space.spaceBookmarks.includes(id));
            for (const id of previousPins) if (!space.spaceBookmarks.includes(id)) await Utils.removePinnedTabState(id);
        } catch (error) {
            Logger.warn('Space bookmark association needs recovery:', space.id, error);
        }
        createSpaceElement(space);
    }
    await saveSpaces();
    const activeTab = allTabs.find(t => t.active && t.windowId === currentWindow.id);
    activeChromeTabId = activeTab?.id;
    const { activeSpaces = {} } = await chrome.storage.session.get('activeSpaces');
    await setActiveSpace(activeSpaces[currentWindow.id] || ownerOf(spaces, activeTab?.id)?.id || spaces[0]?.id, false);
    previousSpaceId = activeSpaceId;
    setupDOMElements(createNewSpace);
    sidebarReady = true;
    refreshCoordinator.schedule();
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.spaces || !sidebarReady) return;
        scheduleStoredSpacesRefresh();
    });
    await offerTabGroupImport();
}
function scheduleStoredSpacesRefresh() {
    refreshCoordinator.invalidateSpaces();
}

async function offerTabGroupImport() {
    const { tabGroupImportDismissed } = await chrome.storage.local.get('tabGroupImportDismissed');
    if (tabGroupImportDismissed) return;
    const groups = await chrome.tabGroups.query({ windowId: currentWindow.id });
    if (!groups.length) return;
    const notice = document.createElement('div');
    notice.className = 'tab-group-import';
    const text = document.createElement('p');
    text.textContent = 'Create spaces from your existing Chrome tab groups? Your groups will stay unchanged.';
    const actions = document.createElement('div');
    actions.className = 'tab-group-import-actions';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'sidebar-text-action sidebar-text-action-primary';
    accept.textContent = 'Create spaces';
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'sidebar-text-action';
    dismiss.textContent = 'No thanks';
    accept.onclick = async () => {
        accept.disabled = true;
        try {
            await pendingSpaceSaves;
            await adoptStoredSpaces(await spaceRequest('import', { windowId: currentWindow.id }));
            notice.remove();
        } catch (error) { accept.disabled = false; Logger.error('Import failed', error); }
    };
    dismiss.onclick = async () => {
        await chrome.storage.local.set({ tabGroupImportDismissed: true });
        notice.remove();
    };
    actions.append(accept, dismiss);
    notice.append(text, actions);
    document.getElementById('sidebar-container').prepend(notice);
}

async function getOwnedTabs(spaceId) {
    const space = spaces.find(s => s.id === spaceId);
    return selectWindowSpaceTabs(space, await chrome.tabs.query({ windowId: currentWindow.id }), currentWindow.id);
}

function createSpaceElement(space) {
    Logger.log('Creating space element for:', space.id);
    const spaceElement = spaceTemplate.content.cloneNode(true);
    const spaceContainer = spaceElement.querySelector('.space');
    spaceContainer.dataset.spaceId = space.id;
    spaceContainer.style.display = space.id === activeSpaceId ? 'flex' : 'none';
    spaceContainer.dataset.spaceUuid = space.id;

    const colorSelect = spaceElement.getElementById('spaceColorSelect');
    colorSelect.value = space.color;
    setupSpaceColorPicker(colorSelect, spaceElement.getElementById('spaceOptionColorSwatch'));
    colorSelect.addEventListener('change', async () => {
        space.color = colorSelect.value;
        if (space.id === activeSpaceId) applySpaceColor(space.color);
        saveSpaces();
        await updateSpaceSwitcher();
    });

    const nameInput = spaceElement.querySelector('.space-name');
    const heading = spaceElement.querySelector('.space-toggle-chevron');
    const title = heading.querySelector('.space-title');
    nameInput.value = space.name;
    title.textContent = space.name;
    let spaceEditSession;
    spaceElement.querySelector('.rename-space-btn').addEventListener('click', () => {
        if (spaceEditSession) return;
        spaceEditSession = editorSessions.begin('space', space.id);
        heading.hidden = true;
        nameInput.hidden = false;
        nameInput.focus();
        nameInput.select();
    });
    nameInput.addEventListener('keydown', event => {
        if (event.key !== 'Escape' && event.key !== 'Enter') return;
        event.preventDefault();
        if (event.key === 'Escape') nameInput.value = space.name;
        nameInput.blur();
        heading.focus();
    });
    nameInput.addEventListener('blur', async () => {
        const session = spaceEditSession;
        const name = nameInput.value.trim() || space.name;
        nameInput.hidden = true;
        heading.hidden = false;
        try {
            await editorSessions.complete(session, async () => {
                if (name === space.name) return;
                const folder = await getSpaceBookmarkFolder(space);
                await chrome.bookmarks.update(folder.id, { title: name });
                await LocalStorage.updateSpaceRegistryEntry(folder.id, { name });
                space.name = name;
                await saveSpaces();
                await updateSpaceSwitcher();
            });
        } catch (error) {
            alert(error.message);
        } finally {
            nameInput.value = space.name;
            title.textContent = space.name;
            spaceEditSession = null;
        }
    });

    const pinnedSection = spaceContainer.querySelector('.pinned-tabs');
    pinnedSection.id = `pinned-bookmarks-${space.id}`;
    heading.setAttribute('aria-controls', pinnedSection.id);
    setPinnedSectionCollapsed(spaceContainer, localStorage.getItem(`space-${space.id}-pinned-collapsed`) === 'true', false);
    heading.addEventListener('click', () => setPinnedSectionCollapsed(spaceContainer, !pinnedSection.hidden));

    // Set up containers
    const pinnedContainer = spaceElement.querySelector('[data-tab-type="pinned"]');
    const tempContainer = spaceElement.querySelector('[data-tab-type="temporary"]');
    const placeholderContainer = spaceElement.querySelector('.placeholder-container');

    // Set up drag and drop
    setupDragAndDrop(pinnedContainer, tempContainer);

    // Set up drag and drop for placeholder container to make entire placeholder area droppable
    if (placeholderContainer) {
        setupPlaceholderDragAndDrop(placeholderContainer, pinnedContainer);
    }

    setupCleanPreview(spaceContainer, currentWindow.id);
    setupCleanArchiveControls(spaceContainer);

    // Set up options menu
    const newFolderBtn = spaceElement.querySelector('.new-folder-btn');
    const deleteSpaceBtn = spaceElement.querySelector('.delete-space-btn');
    const settingsBtn = spaceElement.querySelector('.settings-btn');

    newFolderBtn.addEventListener('click', () => {
        createNewFolder(spaceContainer);
    });

    deleteSpaceBtn.disabled = space.id === resolveDefaultSpace(spaces, defaultSpaceName)?.id;
    deleteSpaceBtn.addEventListener('click', async () => {
        if (space.id === resolveDefaultSpace(spaces, defaultSpaceName)?.id) return;
        let message;
        try {
            const folder = await getSpaceBookmarkFolder(space);
            const count = countBookmarks((await chrome.bookmarks.getSubTree(folder.id))[0]);
            message = `Delete "${space.name}"? This deletes its bookmark folder (${count} ${count === 1 ? 'bookmark' : 'bookmarks'}) and closes its tabs.`;
        } catch (error) {
            message = `Delete "${space.name}"? Its bookmark folder could not be read. ${error.message}`;
        }
        if (confirm(message)) {
            try {
                await deleteSpace(space.id);
            } catch (error) {
                alert(error.message);
            }
        }
    });

    settingsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // Load tabs
    loadTabs(space, pinnedContainer, tempContainer).then(() => {
        // Update placeholders after loading tabs (ensure this happens after all async operations)
        updatePinnedSectionPlaceholders();
    });

    const popup = spaceElement.querySelector('.archived-tabs-popup');
    const archiveButton = spaceElement.querySelector('.sidebar-button');
    const spaceContent = spaceElement.querySelector('.space-content');

    archiveButton.addEventListener('click', (e) => {
        closeCleanPreview();
        e.stopPropagation(); // Prevent closing immediately if clicking outside logic exists
        spaceContent.classList.toggle('hidden');
        const isVisible = popup.style.opacity == 1;
        if (isVisible) {
            popup.classList.toggle('visible');
        } else {
            showArchivedTabsPopup(space.id); // Populate and show
            popup.classList.toggle('visible');
        }
    });

    // Add to DOM
    spacesList.appendChild(spaceElement);

    // Set up settings button to open extension options
    const settingsButton = spaceElement.querySelector('#space-settings');
    if (settingsButton) {
        settingsButton.addEventListener('click', () => {
            if (chrome && chrome.runtime && chrome.runtime.openOptionsPage) {
                chrome.runtime.openOptionsPage();
            }
        });
    }
}

async function moveSpaceFolderBefore(space, nextSpace) {
    try {
        const arcifyFolder = await getSidebarBookmarkRoot();
        const children = await chrome.bookmarks.getChildren(arcifyFolder.id);
        if (!children.some(node => node.id === space.bookmarkFolderId)) return;
        const nextIndex = children.findIndex(node => node.id === nextSpace?.bookmarkFolderId);
        const index = nextIndex < 0 ? children.length : nextIndex;
        await chrome.bookmarks.move(space.bookmarkFolderId, { parentId: arcifyFolder.id, index });
    } catch (error) {
        showSpaceStoreError(error, 'bookmark_folder_unavailable');
        Logger.warn('Could not reorder space folder:', error);
    }
}

function clearSpaceSwitcherDropPlaceholders() {
    const buttons = spaceSwitcher.querySelectorAll('button');
    buttons.forEach(button => {
        button.classList.remove('drag-over-placeholder-before', 'drag-over-placeholder-after');
    });
}

const SPACE_DRAG_DWELL_MS = 450;
let spaceDragHover = null;
let spaceDragPreview = null;

function clearSpaceDragHover() {
    if (!spaceDragHover) return;
    clearTimeout(spaceDragHover.timer);
    spaceDragHover.button.classList.remove('space-drag-hover');
    spaceDragHover = null;
}

function endSpaceDragPreview() {
    clearSpaceDragHover();
    if (!spaceDragPreview) return;
    const { element, origin } = spaceDragPreview;
    element.classList.remove('space-drag-preview');
    element.style.display = element.dataset.spaceId === activeSpaceId ? 'flex' : 'none';
    origin.style.display = origin.dataset.spaceId === activeSpaceId ? 'flex' : 'none';
    spaceSwitcher.querySelector('.space-drag-destination')?.classList.remove('space-drag-destination');
    spaceDragPreview = null;
    const activeSpace = spaces.find(space => space.id === activeSpaceId);
    if (activeSpace) applySpaceColor(activeSpace.color);
}

async function showSpaceDragPreview(hover) {
    const { button } = hover;
    const spaceId = button.dataset.spaceId;
    if (spaceId === activeSpaceId) {
        endSpaceDragPreview();
        return;
    }
    const space = spaces.find(item => item.id === spaceId);
    const element = getSpaceElement(spaceId);
    const origin = getSpaceElement(activeSpaceId);
    if (!space || !element || !origin) return;
    const { pinned, temp } = getContainers(element);
    if (await loadTabs(space, pinned, temp, { force: true }) === false) return;
    if (spaceDragHover !== hover || !button.isConnected || !element.isConnected || !isDraggingTab) return;
    endSpaceDragPreview();
    updatePinnedSectionPlaceholders(element);
    origin.style.display = 'none';
    element.style.display = 'flex';
    element.classList.add('space-drag-preview');
    button.classList.add('space-drag-destination');
    spaceDragPreview = { element, origin };
    applySpaceColor(space.color);
}

function handleSpaceSwitcherDragOver(e) {
    if (!document.querySelector('.dragging-switcher')) {
        const button = e.target.closest('button[data-space-id]');
        if (spaceDragHover?.button !== button) clearSpaceDragHover();
        if (!tabDragPreview.rows.length || tabDragPreview.cancelled || !button ||
            spaceDragHover || button.dataset.spaceId === (spaceDragPreview?.element.dataset.spaceId || activeSpaceId)) return;
        const hover = { button, timer: null };
        spaceDragHover = hover;
        button.classList.add('space-drag-hover');
        hover.timer = setTimeout(() => {
            showSpaceDragPreview(hover).catch(error => Logger.warn('Could not preview drag destination:', error));
        }, SPACE_DRAG_DWELL_MS);
        return;
    }
    e.preventDefault();

    const afterElement = getDragAfterElementSwitcher(spaceSwitcher, e.clientX);
    clearSpaceSwitcherDropPlaceholders();

    if (afterElement) {
        afterElement.classList.add('drag-over-placeholder-before');
    } else {
        const lastElement = spaceSwitcher.querySelector('button:not(.dragging-switcher):last-of-type');
        if (lastElement) {
            lastElement.classList.add('drag-over-placeholder-after');
        }
    }
}

function handleSpaceSwitcherDragLeave(e) {
    if (spaceDragHover && !spaceDragHover.button.contains(e.relatedTarget)) clearSpaceDragHover();
    if (e.target === spaceSwitcher) {
        clearSpaceSwitcherDropPlaceholders();
    }
}

async function handleSpaceSwitcherDrop(e) {
    e.preventDefault();
    const afterElement = getDragAfterElementSwitcher(spaceSwitcher, e.clientX);
    clearSpaceSwitcherDropPlaceholders();

    if (draggedSpaceSwitcherButton) {
        const draggedSpaceId = draggedSpaceSwitcherButton.dataset.spaceId;
        const targetSpaceId = afterElement?.dataset.spaceId;
        const originalIndex = spaces.findIndex(space => space.id === draggedSpaceId);
        if (originalIndex === -1) return;

        const [draggedSpace] = spaces.splice(originalIndex, 1);
        const targetIndex = targetSpaceId
            ? spaces.findIndex(space => space.id === targetSpaceId)
            : -1;
        const newIndex = targetIndex >= 0 ? targetIndex : spaces.length;

        spaces.splice(newIndex, 0, draggedSpace);
        await moveSpaceFolderBefore(draggedSpace, spaces[newIndex + 1]);
        saveSpaces();
        await updateSpaceSwitcher();
    }
    draggedSpaceSwitcherButton = null;
}

addDragListener(spaceSwitcher, 'dragover', handleSpaceSwitcherDragOver);
addDragListener(spaceSwitcher, 'dragleave', handleSpaceSwitcherDragLeave);
addDragListener(spaceSwitcher, 'drop', handleSpaceSwitcherDrop);

function updateDeleteSpaceButtons() {
    const mainId = resolveDefaultSpace(spaces, defaultSpaceName)?.id;
    for (const panel of spacesList.querySelectorAll('.space')) {
        panel.querySelector('.delete-space-btn').disabled = panel.dataset.spaceId === mainId;
    }
}

async function updateSpaceSwitcher() {
    updateDeleteSpaceButtons();
    Logger.log('Updating space switcher...');
    spaceSwitcher.innerHTML = '';


    spaces.forEach(space => {
        const button = document.createElement('button');
        button.textContent = space.name;
        button.dataset.spaceId = space.id; // Store space ID
        button.classList.toggle('active', space.id === activeSpaceId);
        button.draggable = true; // Make the button draggable

        button.addEventListener('click', async () => {
            if (button.classList.contains('dragging-switcher')) return;

            Logger.log("clicked for active", space);
            await setActiveSpace(space.id);
        });

        // --- Drag Event Listeners for Buttons ---
        addDragListener(button, 'dragstart', (e) => {
            draggedSpaceSwitcherButton = button;
            // Use a specific class to avoid conflicts with tab dragging
            setTimeout(() => button.classList.add('dragging-switcher'), 0);
            e.dataTransfer.effectAllowed = 'move';
            // Optional: Set drag data if needed elsewhere, though not strictly necessary for reordering within the same list
            // e.dataTransfer.setData('text/plain', space.id);
        });

        addDragListener(button, 'dragend', () => {
            // Clean up placeholders and dragging class on drag end (cancel/drop outside)
            const buttons = spaceSwitcher.querySelectorAll('button');
            buttons.forEach(btn => {
                btn.classList.remove('drag-over-placeholder-before', 'drag-over-placeholder-after');
            });
            if (draggedSpaceSwitcherButton) {
                draggedSpaceSwitcherButton.classList.remove('dragging-switcher');
            }
            draggedSpaceSwitcherButton = null;
        });

        spaceSwitcher.appendChild(button);
    });

    // Inactive space from bookmarks
    const arcifyFolder = await getSidebarBookmarkRoot();
    const spaceFolders = await chrome.bookmarks.getChildren(arcifyFolder.id);
    spaceFolders.forEach(spaceFolder => {
        if (spaces.find(space => space.name == spaceFolder.title)) {
            return;
        } else {
            const button = document.createElement('button');
            button.textContent = spaceFolder.title;
            button.addEventListener('click', async () => {
                const newTab = await ChromeHelper.createNewTab();
                await createSpaceFromInactive(spaceFolder.title, newTab);
            });
            spaceSwitcher.appendChild(button);
        }
    });

    // const spaceFolder = spaceFolders.find(f => f.title === space.name);

}

// Wrapper functions that use the unified getDragAfterElement from domManager.js
function getDragAfterElementSwitcher(container, x) {
    return getDragAfterElement(container, x, {
        axis: 'x',
        selector: 'button:not(.dragging-switcher)'
    });
}

function getDragAfterElementTabs(container, y) {
    return getDragAfterElement(container, y, {
        axis: 'y',
        selector: ':scope > .tab:not(.dragging):not(.multi-dragging), :scope > .folder:not(.dragging)',
        placeholderSelector: ':scope > .tab-placeholder'
    });
}


// Helper function to set up drag event listeners for tab elements
function setupTabDragHandlers(tabElement) {
    tabElement.addEventListener('mousedown', event => tabPointerDrag.prepare(event, tabElement));
    addDragListener(tabElement, 'dragstart', event => {
        if (pendingMutationCount > 0) {
            event.preventDefault();
            return;
        }
        isDraggingTab = true;
        event.dataTransfer.setData('text/plain', tabElement.dataset.tabId || tabElement.dataset.url || '');
        event.dataTransfer.effectAllowed = 'move';
        const tabId = Number(tabElement.dataset.tabId);
        draggingTabIds = tabId
            ? getContextTabIds(selectedTabIds, tabId)
            : [];
        const draggingElements = draggingTabIds.length > 1
            ? getOrderedTabElementsById(draggingTabIds)
            : [tabElement];
        draggingTabIds = draggingElements
            .map(element => Number(element.dataset.tabId))
            .filter(Boolean);
        draggingElements.forEach(element => element.classList.add('multi-dragging'));
        tabElement.classList.add('dragging');
        tabDragPreview.start(draggingElements);
    });

    addDragListener(tabElement, 'dragend', () => {
        tabDragPreview.end();
        if (!tabDropCommitting) {
            endSpaceDragPreview();
            restoreDragFolders();
        }
        hideAllDropIndicators();
        clearFolderOpenTimer();
        isDraggingTab = false;
        document.querySelectorAll('.dragging, .multi-dragging').forEach(element => element.classList.remove('dragging', 'multi-dragging'));
        draggingTabIds = [];
        refreshCoordinator.schedule();
    });
}

// Folders drag from their header and move as one bookmark.
function setupFolderDragHandlers(folderElement) {
    const folderHeader = folderElement.querySelector(':scope > .folder-header');
    addDragListener(folderHeader, 'dragstart', event => {
        if (event.target !== folderHeader) return;
        if (folderHeader.querySelector('.folder-name') === document.activeElement) {
            event.preventDefault();
            return;
        }
        isDraggingTab = true;
        event.dataTransfer.setData('text/plain', folderElement.dataset.bookmarkId || '');
        event.dataTransfer.effectAllowed = 'move';
        folderElement.classList.add('dragging');
    });

    addDragListener(folderHeader, 'dragend', () => {
        isDraggingTab = false;
        folderElement.classList.remove('dragging');
        refreshCoordinator.schedule();
    });
}

// A tab dropped on a folder header goes inside it. A folder dropped there is placed
// beside it instead, and goes inside only when dropped into an open folder's content.
function getDropTargetFolderContent(target, draggingElement) {
    if (draggingElement.classList.contains('folder')) return target.closest('.folder-content');
    return target.closest('.folder')?.querySelector(':scope > .folder-content');
}

function isInvalidDrop(draggingElement, container, targetContainer) {
    const pinned = container.dataset.tabType === 'pinned';
    if (draggingElement.classList.contains('pinned-favicon') && !draggingElement.dataset.tabId) return true;
    if (draggingElement.classList.contains('folder')) return !pinned || draggingElement.contains(targetContainer);
    return !pinned && draggingElement.classList.contains('bookmark-only');
}

// Variables for folder auto-open functionality
let folderOpenTimer = null;
let currentHoveredFolder = null;
const dragOpenedFolders = new Set();

function setFolderCollapsed(folderElement, collapsed, persist = true) {
    folderElement.classList.toggle('collapsed', collapsed);
    folderElement.querySelector(':scope > .folder-content').classList.toggle('collapsed', collapsed);
    const toggle = folderElement.querySelector('.folder-toggle');
    toggle.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    syncCollapsedFolderTabs(folderElement);
    if (persist) {
        saveFolderCollapsed(folderElement.dataset.bookmarkId, collapsed)
            .catch(error => Logger.error('Could not save folder state', error));
    }
}

function openFolder(folderElement) {
    if (folderElement.classList.contains('collapsed')) setFolderCollapsed(folderElement, false);
}

function restoreDragFolders() {
    for (const folder of dragOpenedFolders) {
        if (folder.isConnected) setFolderCollapsed(folder, true, false);
    }
    dragOpenedFolders.clear();
}

// Helper function to start auto-open timer for a folder
function startFolderOpenTimer(folderElement) {
    clearFolderOpenTimer(); // Clear any existing timer

    currentHoveredFolder = folderElement;
    folderOpenTimer = setTimeout(() => {
        if (currentHoveredFolder === folderElement && folderElement.classList.contains('collapsed')) {
            if (tabDragPreview.rows.length) {
                dragOpenedFolders.add(folderElement);
                setFolderCollapsed(folderElement, false, false);
            } else {
                openFolder(folderElement);
            }
        }
        folderOpenTimer = null;
        currentHoveredFolder = null;
    }, 250); // 750ms delay like macOS Finder
}

// Helper function to clear the folder auto-open timer
function clearFolderOpenTimer() {
    if (folderOpenTimer) {
        clearTimeout(folderOpenTimer);
        folderOpenTimer = null;
    }
    currentHoveredFolder = null;
}

async function setActiveSpace(spaceId, updateTab = true, { source } = {}) {
    const space = spaces.find(s => s.id === spaceId);
    // The drop owns the visible destination through its asynchronous save.
    if (!space || (tabDropCommitting && source !== 'drop')) return;
    if (source !== 'swipe') spaceSwipe?.cancel();
    const spaceChanged = activeSpaceId !== spaceId;
    if (spaceChanged && isDraggingTab) tabPointerDrag.cancel();
    if (activeSpaceId && activeSpaceId !== spaceId) {
        previousSpaceId = activeSpaceId;
        const activeEditor = document.activeElement?.closest?.(`[data-space-id="${activeSpaceId}"]`);
        if (activeEditor) document.activeElement.blur();
        editorSessions.dispose('folder-pending', activeSpaceId);
    }
    activeSpaceId = spaceId;
    if (spaceChanged) {
        closeCleanPreview();
        clearTabSelection();
    }
    await pendingSpaceSaves;
    await spaceRequest('activate', { windowId: currentWindow.id, spaceId });
    await activateSpaceInDOM(spaceId, spaces, updateSpaceSwitcher);
    await refreshActiveSpaceUI();
    if (updateTab) {
        const tabs = (await getOwnedTabs(spaceId)).filter(t => t.windowId === currentWindow.id);
        const tab = tabs.find(t => t.id === space.lastTab) || tabs[tabs.length - 1];
        if (tab) {
            await chrome.tabs.update(tab.id, { active: true });
            activateTabInDOM(tab.id);
        }
    }
}

async function createSpaceFromInactive(spaceName, tabToMove) {
    Logger.log(`Creating inactive space "${spaceName}" with tab:`, tabToMove);
    isCreatingSpace = true;
    try {
        const arcifyFolder = await getSidebarBookmarkRoot();
        const spaceFolders = await chrome.bookmarks.getChildren(arcifyFolder.id);
        const spaceFolder = spaceFolders.find(f => f.title === spaceName);

        if (!spaceFolder) {
            Logger.error(`Bookmark folder for inactive space "${spaceName}" not found.`);
            return;
        }

        const oldSpace = spaces.find(s =>
            s.temporaryTabs.includes(tabToMove.id) || s.spaceBookmarks.includes(tabToMove.id)
        );
        const isPinned = !!oldSpace?.spaceBookmarks.includes(tabToMove.id);
        let movedTabIds = [tabToMove.id];
        if (isPinned) {
            const binding = await Utils.getPinnedTabState(tabToMove.id);
            const bookmark = await getSpaceBookmarkById(oldSpace, binding?.bookmarkId);
            if (!bookmark) throw new Error('The favorite binding is no longer valid for this space.');
            movedTabIds = await getTabsBoundToBookmark(oldSpace, bookmark.id);
            await chrome.bookmarks.move(bookmark.id, { parentId: spaceFolder.id });
        }

        const spaceColor = await Utils.getSpaceColor(spaceName, null);

        const registryEntry = await LocalStorage.getOrCreateSpaceRegistryEntry(spaceFolder.id, {
            name: spaceName,
            color: spaceColor || DEFAULT_SPACE_COLOR,
        });

        const space = {
            id: registryEntry.spaceUuid,
            spaceUuid: registryEntry?.spaceUuid ?? Utils.generateUUID(),
            bookmarkFolderId: spaceFolder.id,
            uuid: registryEntry?.spaceUuid ?? Utils.generateUUID(),
            name: spaceName,
            color: spaceColor || registryEntry.color || DEFAULT_SPACE_COLOR,
            spaceBookmarks: isPinned ? movedTabIds : [],
            temporaryTabs: isPinned ? [] : [tabToMove.id],
            lastTab: tabToMove.id,
        };

        // Remove the moved tab from its old space
        if (oldSpace) {
            oldSpace.temporaryTabs = oldSpace.temporaryTabs.filter(id => !movedTabIds.includes(id));
            oldSpace.spaceBookmarks = oldSpace.spaceBookmarks.filter(id => !movedTabIds.includes(id));
        }

        // Remove the tab's DOM element from the old space's UI
        const tabElementToRemove = document.querySelector(`[data-tab-id="${tabToMove.id}"]`);
        if (tabElementToRemove) {
            tabElementToRemove.remove();
        }

        spaces.push(space);
        saveSpaces();
        createSpaceElement(space);
        await setActiveSpace(space.id);
        updateSpaceSwitcher();
    } catch (error) {
        showSpaceStoreError(error, 'bookmark_folder_unavailable');
        Logger.error(`Error creating space from inactive bookmark:`, error);
    } finally {
        isCreatingSpace = false;
    }
}

function saveSpaces(condition) {
    pendingSaveCount++;
    const run = spaceSaveQueue.submit(spaces, condition);
    pendingSpaceSaves = run.catch(error => Logger.error('Saving spaces failed', error)).finally(() => {
        pendingSaveCount--;
        refreshCoordinator.schedule();
    });
    return run;
}

async function moveTabToPinned(space, tab, refresh = true) {
    space = spaces.find(s => s.id === space.id);
    if (!space) return;
    const spaceFolder = await getSpaceBookmarkFolder(space);
    const created = await chrome.bookmarks.create({
        parentId: spaceFolder.id, title: tab.title, url: tab.url
    });
    const bookmarkIdToStore = created.id;

    // Track the original pinned URL for Arc-like "Back to Pinned URL" behavior.
    await Utils.setPinnedTabState(tab.id, { pinnedUrl: tab.url, bookmarkId: bookmarkIdToStore });

    space.temporaryTabs = space.temporaryTabs.filter(id => id !== tab.id);
    if (!space.spaceBookmarks.includes(tab.id)) {
        space.spaceBookmarks.push(tab.id);
    }

    // Update placeholders after moving tab to pinned
    updatePinnedSectionPlaceholders();

    // Persist extension ordering after membership changes.
    await persistSpaceTabOrder(space.id, { source: 'arcify', movedTabId: tab.id });
    if (refresh) await refreshActiveSpaceUI();
}

function offerFavoriteUndo(removed, restoreTab = null) {
    if (!removed) return;
    // A bookmark is the favorite's durable record, so give intentional removal a recovery window.
    showUndoToast('Favorite removed.', async () => {
        const bookmark = await restoreSpacePin(removed);
        if (restoreTab) await restoreTab(bookmark);
        scheduleBookmarkRefresh();
    });
}

async function restoreFavoriteTab(spaceId, tabId, index, bookmark, fromSpaceId = spaceId) {
    const space = spaces.find(s => s.id === spaceId);
    const current = spaces.find(s => s.id === fromSpaceId);
    if (!space || !current?.temporaryTabs.includes(tabId)) return;
    await Utils.setPinnedTabState(tabId, { pinnedUrl: bookmark.url, bookmarkId: bookmark.id });
    current.temporaryTabs = current.temporaryTabs.filter(id => id !== tabId);
    space.spaceBookmarks.splice(index, 0, tabId);
    await persistSpaceTabOrder(space.id, { source: 'arcify', movedTabId: tabId });
    await refreshActiveSpaceUI();
}

async function moveTabToTemp(space, tab, { temporaryDisplayOrder = null, inverted = false, refresh = true, offerUndo = true } = {}) {
    space = spaces.find(s => s.id === space.id);
    if (!space) return;
    const favoriteIndex = space.spaceBookmarks.indexOf(tab.id);
    const removed = await removeSpacePin(space, tab);
    if (offerUndo) offerFavoriteUndo(removed,
        bookmark => restoreFavoriteTab(space.id, tab.id, favoriteIndex, bookmark));

    // Move tab from bookmarks to temporary tabs in space data
    space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== tab.id);
    if (!space.temporaryTabs.includes(tab.id)) {
        space.temporaryTabs.push(tab.id);
    }
    if (temporaryDisplayOrder) {
        space.temporaryTabs = mergeCapturedTemporaryOrder(space.temporaryTabs, temporaryDisplayOrder, inverted);
    }

    // No longer a space-pinned tab; clear pinned state mapping.
    await Utils.removePinnedTabState(tab.id);

    // Persist extension ordering after membership changes.
    await persistSpaceTabOrder(space.id, { source: 'arcify', movedTabId: tab.id });
    if (refresh) await refreshActiveSpaceUI();
    return { removed, favoriteIndex };
}

function offerFavoritesUndo(removedFavorites) {
    if (removedFavorites.length) {
        showUndoToast(removedFavorites.length === 1 ? 'Favorite removed.' : `${removedFavorites.length} favorites removed.`, async () => {
            // Restore siblings in their original order so saved indices stay meaningful.
            for (const item of removedFavorites.sort((a, b) => a.index - b.index)) {
                const { tabId, spaceId, fromSpaceId, favoriteIndex, relatedTabs = [], ...details } = item;
                const bookmark = await restoreSpacePin(details);
                await restoreFavoriteTab(spaceId, tabId, favoriteIndex, bookmark, fromSpaceId);
                for (const { id, index } of relatedTabs) await restoreFavoriteTab(spaceId, id, index, bookmark);
            }
            scheduleBookmarkRefresh();
        });
    }
}

async function setTabsSpacePinned(tabIds, pinned) {
    clearTabSelection();
    const removedFavorites = [];
    const originalPositions = new Map(tabIds.map(id => [id, ownerOf(spaces, id)?.spaceBookmarks.indexOf(id)]));
    const originalBookmarkIndices = new Map();
    if (!pinned) {
        for (const tabId of tabIds) {
            const space = ownerOf(spaces, tabId);
            const binding = await Utils.getPinnedTabState(tabId);
            const bookmark = space && await getSpaceBookmarkById(space, binding?.bookmarkId);
            if (bookmark) originalBookmarkIndices.set(tabId, bookmark.index);
        }
    }
    for (const tabId of tabIds) {
        const space = ownerOf(spaces, tabId);
        if (!space) continue;
        const alreadyPinned = space.spaceBookmarks.includes(tabId);
        if (alreadyPinned === pinned) continue;
        try {
            const tab = await chrome.tabs.get(tabId);
            if (pinned) await moveTabToPinned(space, tab, false);
            else {
                const result = await moveTabToTemp(space, tab, { refresh: false, offerUndo: false });
                if (result?.removed) removedFavorites.push({ ...result.removed, index: originalBookmarkIndices.get(tabId) ?? result.removed.index, tabId, spaceId: space.id, favoriteIndex: originalPositions.get(tabId) });
            }
        } catch (error) {
            Logger.warn(`Could not ${pinned ? 'pin' : 'unpin'} selected tab ${tabId}`, error);
        }
    }
    offerFavoritesUndo(removedFavorites);
    await refreshActiveSpaceUI();
}

async function moveTabsToSpace(tabIds, spaceId, focusTabId = tabIds.at(-1)) {
    clearTabSelection();
    for (const tabId of tabIds) {
        const source = ownerOf(spaces, tabId);
        const tab = await chrome.tabs.get(tabId);
        if (source?.spaceBookmarks.includes(tabId)) {
            const element = document.querySelector(`.tab[data-tab-id="${tabId}"]`);
            if (!element) throw new Error('The selected favorite is no longer available.');
            await moveFavoriteToSpace(tab, element, spaceId);
        } else {
            await moveTabToSpace(tabId, spaceId, false);
        }
    }
    await setActiveSpace(spaceId, false);
    if (focusTabId && tabIds.includes(focusTabId)) await Utils.focusTab(focusTabId);
}

async function createInactiveSpaceWithTabs(spaceName, tabIds) {
    const tabs = [];
    for (const tabId of tabIds) {
        try { tabs.push(await chrome.tabs.get(tabId)); }
        catch (error) { Logger.warn(`Selected tab ${tabId} is no longer available`, error); }
    }
    if (!tabs.length) return;
    clearTabSelection();
    await createSpaceFromInactive(spaceName, tabs[0]);
    const targetSpace = spaces.find(space => space.name === spaceName);
    if (!targetSpace) return;
    await moveTabsToSpace(tabs.slice(1).map(tab => tab.id), targetSpace.id, tabs.at(-1).id);
    await setActiveSpace(targetSpace.id, false);
    await Utils.focusTab(tabs.at(-1).id);
}

let creatingFolderWithItems = false;

// A failed membership write can leave a new bookmark attached to a temporary
// tab. Roll it back only if both the saved state and worker still own that tab
// as temporary, and the bookmark and binding are still ours.
async function rollbackUnfiledTabs(spaceId, folderId, bindings) {
    if (!bindings.length) return;
    const [{ spaces: savedSpaces = [] }, workerSpaces] = await Promise.all([
        chrome.storage.local.get('spaces'),
        spaceRequest('get')
    ]);
    for (const { tabId, bookmarkId, previous } of bindings) {
        if (![savedSpaces, workerSpaces].every(list =>
            list.find(space => space.id === spaceId)?.temporaryTabs.includes(tabId))) continue;
        const current = await Utils.getPinnedTabState(tabId);
        if (current?.bookmarkId !== bookmarkId) continue;
        const [bookmark] = await chrome.bookmarks.get(bookmarkId).catch(() => []);
        if (bookmark?.parentId !== folderId) continue;
        await chrome.bookmarks.remove(bookmarkId);
        if (previous) await Utils.setPinnedTabState(tabId, previous);
        else await Utils.removePinnedTabState(tabId);
    }
    // Chrome refuses this removal if any bookmarks or folders remain inside.
    await chrome.bookmarks.remove(folderId).catch(() => {});
}

async function createFolderWithItems(spaceId, entries) {
    const space = spaces.find(item => item.id === spaceId);
    if (creatingFolderWithItems || !space || space.id !== activeSpaceId) return;
    creatingFolderWithItems = true;
    pendingMutationCount++;
    try {
        const spaceFolder = await getSpaceBookmarkFolder(space);
        const selected = [];
        // Resolve the native identities before creating or moving any bookmarks.
        for (const { tabId, bookmarkId } of entries) {
            const tab = tabId == null ? null : await chrome.tabs.get(tabId);
            if (tab && (tab.windowId !== currentWindow.id || tab.pinned || ownerOf(spaces, tabId)?.id !== spaceId)) {
                throw new Error('The selected tab no longer belongs to this space.');
            }
            const stored = tab && await Utils.getPinnedTabState(tabId);
            const savedId = bookmarkId || stored?.bookmarkId;
            const bookmark = savedId && await getSpaceBookmarkById(space, savedId);
            if ((savedId && !bookmark) || (!bookmark && (!tab?.url || space.spaceBookmarks.includes(tabId)))) {
                throw new Error('The selected item no longer has a valid bookmark or page. Refresh and retry.');
            }
            selected.push({ tab, stored, bookmark });
        }

        const itemParent = selected.length === 1 ? selected[0].bookmark?.parentId : undefined;
        const parentId = itemParent && await canCreateFolder(spaceFolder.id, itemParent) ? itemParent : spaceFolder.id;
        if (activeSpaceId !== spaceId) return;
        const folder = await createFolder(spaceFolder.id, parentId, 'New Folder');
        let membershipChanged = false;
        const newBindings = [];
        try {
            // A bookmark can back live tabs in several windows. Moving its native
            // ID within the same space also preserves those existing bindings.
            for (const { tab, stored, bookmark } of selected) {
                const saved = bookmark
                    ? await chrome.bookmarks.move(bookmark.id, { parentId: folder.id })
                    : await chrome.bookmarks.create({ parentId: folder.id, title: tab.title, url: tab.url });
                if (!tab) continue;
                try {
                    await Utils.setPinnedTabState(tab.id, { bookmarkId: saved.id, pinnedUrl: stored?.pinnedUrl || saved.url });
                } catch (error) {
                    if (!bookmark) await chrome.bookmarks.remove(saved.id).catch(() => {});
                    throw error;
                }
                if (!bookmark) newBindings.push({ tabId: tab.id, bookmarkId: saved.id, previous: stored });
                if (!space.spaceBookmarks.includes(tab.id)) {
                    space.temporaryTabs = space.temporaryTabs.filter(id => id !== tab.id);
                    space.spaceBookmarks.push(tab.id);
                    membershipChanged = true;
                }
            }
        } catch (error) {
            // Chrome refuses to remove a nonempty folder. Keep any completed moves.
            await chrome.bookmarks.remove(folder.id).catch(() => {});
            throw error;
        } finally {
            if (membershipChanged) {
                try {
                    await saveSpaces();
                } catch (error) {
                    await rollbackUnfiledTabs(spaceId, folder.id, newBindings)
                        .catch(rollbackError => Logger.warn('Could not recover unfinished folder items:', rollbackError));
                    throw error;
                }
            }
        }

        if (selected.length > 1) clearTabSelection();
        await saveFolderCollapsed(folder.id, false);
        if (activeSpaceId !== spaceId) return;
        await refreshActiveSpaceUI({ force: true });
        if (activeSpaceId !== spaceId) return;

        const spaceElement = getSpaceElement(spaceId);
        const folderElement = spaceElement?.querySelector(`.folder[data-bookmark-id="${folder.id}"]`);
        if (!folderElement) return;
        setPinnedSectionCollapsed(spaceElement, false);
        for (let parent = folderElement.parentElement.closest('.folder'); parent; parent = parent.parentElement.closest('.folder')) {
            openFolder(parent);
        }
        folderNameEditors.get(folderElement)?.();
    } finally {
        creatingFolderWithItems = false;
        pendingMutationCount--;
        refreshCoordinator.schedule();
    }
}

async function closeSelectedTabs(tabIds) {
    clearTabSelection();
    await Promise.all(tabIds.map(async tabId => {
        const space = ownerOf(spaces, tabId);
        try {
            const tab = await chrome.tabs.get(tabId);
            const element = document.querySelector(`.tab[data-tab-id="${tabId}"]`);
            if (element) await closeTab(element, tab, Boolean(space?.spaceBookmarks.includes(tabId)), false);
        } catch (error) {
            Logger.warn(`Could not close selected tab ${tabId}`, error);
        }
    }));
}

function syncCollapsedFolderTabs(folderElement) {
    projectCollapsedFolder(folderElement, showAllOpenTabsInCollapsedFolders);
}

// Update all pinned section placeholders in the current space (folders + main section)
function updatePinnedSectionPlaceholders(currentSpace = getSpaceElement(activeSpaceId)) {
    if (!currentSpace) return;

    // Update folder placeholders
    const folders = currentSpace.querySelectorAll('.folder');
    folders.forEach(folder => {
        updateFolderPlaceholder(folder);
    });

    // Update main space pinned section placeholder
    const pinnedContainer = currentSpace.querySelector('[data-tab-type="pinned"]');
    const placeholderContainer = currentSpace.querySelector('.placeholder-container');

    if (pinnedContainer && placeholderContainer) {
        const placeholder = placeholderContainer.querySelector('.tab-placeholder');
        if (placeholder) {
            // Check if pinned container has any actual content (tabs or folders, not placeholders)
            const hasContent = pinnedContainer.querySelectorAll('.tab:not(.tab-placeholder), .folder').length > 0;

            if (hasContent) {
                placeholder.classList.add('hidden');
            } else {
                placeholder.classList.remove('hidden');
            }
        }
    }
}

// Convert favorite tab (pinned-favicon) to proper tab element
async function convertFavoriteToTab(draggingElement, targetIsPinned) {
    const tabId = parseInt(draggingElement.dataset.tabId);

    // Unpin from Chrome favorites
    await chrome.tabs.update(tabId, { pinned: false });

    // Get fresh tab data and create proper UI element
    const tab = await chrome.tabs.get(tabId);
    const newTabElement = await createTabElement(tab, targetIsPinned, false);

    // Replace the small favicon with full tab element
    draggingElement.replaceWith(newTabElement);

    // Refresh favorites area to remove the original
    updatePinnedFavicons();

    return { tab, newTabElement };
}

function transferDraggedTab(drop, target, tabId, section) {
    const { source } = drop;
    source.temporaryTabs = source.temporaryTabs.filter(id => id !== tabId);
    source.spaceBookmarks = source.spaceBookmarks.filter(id => id !== tabId);
    if (source !== target && source.lastTab === tabId) source.lastTab = null;
    if (!target[section].includes(tabId)) target[section].push(tabId);
    if (tabId === activeChromeTabId) target.lastTab = tabId;
    drop.transfers.set(tabId, { spaceId: target.id, section });
}

function rememberBookmarkRelocation(drop, relocation, bookmarkId, original, sourceRootId) {
    if (!relocation || !bookmarkId) return;
    drop.rollbacks.push(async () => {
        const [current] = await chrome.bookmarks.get(bookmarkId);
        if (current?.parentId !== relocation.parentId) return;
        if (original) {
            if (!await isFolderInBookmarkRoot(original.parentId, sourceRootId)) return;
            const siblings = await chrome.bookmarks.getChildren(original.parentId);
            await chrome.bookmarks.move(bookmarkId, { parentId: original.parentId, index: Math.min(original.index, siblings.length) });
        } else if (current.url === relocation.url && current.title === relocation.title) {
            await chrome.bookmarks.remove(bookmarkId);
        }
    });
}

async function setDropPinBinding(drop, tabId, binding) {
    const same = (left, right) => left?.bookmarkId === right?.bookmarkId && left?.pinnedUrl === right?.pinnedUrl;
    const original = await Utils.getPinnedTabState(tabId);
    if (same(original, binding)) return;
    const write = state => state ? Utils.setPinnedTabState(tabId, state) : Utils.removePinnedTabState(tabId);
    drop.rollbacks.push(async () => {
        if (same(await Utils.getPinnedTabState(tabId), binding)) await write(original);
    });
    await write(binding);
}

// Handle bookmark operations during drop events
async function handleBookmarkOperations(event, draggingElement, container, targetFolder, dropIntent = null) {
    // Validate required elements exist
    if (!draggingElement || !container || !event) {
        Logger.warn('Missing required elements for bookmark operations');
        return;
    }

    if (draggingElement.classList.contains('folder')) {
        const space = spaces.find(s => s.id === container.closest('.space')?.dataset.spaceId);
        const spaceFolder = space && await getSpaceBookmarkFolder(space);
        const folderId = draggingElement.dataset.bookmarkId;
        if (!spaceFolder || !folderId) throw new Error('Folder creation is not complete.');
        const parentId = bookmarkParentIdForContent(dropIntent.bookmarkTargetContent, spaceFolder.id);
        if (!await canMoveFolder(spaceFolder.id, folderId, parentId)) {
            throw new Error('A folder cannot move into itself, and nested folders require tab group sync to be off and support up to four folder levels.');
        }
        const result = await saveBookmarkOperation(makeBookmarkDropOperation({
            sourceContent: dropIntent.bookmarkSourceContent,
            targetContent: dropIntent.bookmarkTargetContent,
            draggingElement,
            rootId: spaceFolder.id,
            inverted: dropIntent.inverted
        }));
        for (const [id, order] of Object.entries(result.orders || {})) bookmarkOrderBaselines.set(String(id), order.map(String));
        return { orderHandled: true };
    }

    // Handle tab being moved to pinned section or folder (both open tabs and bookmark-only tabs)
    if (container.dataset.tabType === 'pinned' && (draggingElement.dataset.tabId || draggingElement.dataset.url)) {
        // Handle favorite tab conversion
        if (draggingElement.classList.contains('pinned-favicon')) {
            const converted = await convertFavoriteToTab(draggingElement, true);
            draggingElement = converted.newTabElement;
        }

        Logger.log("Tab dropped to pinned section or folder");

        // Determine if this is a bookmark-only tab or a regular tab
        const isBookmarkOnly = !draggingElement.dataset.tabId && draggingElement.dataset.url;
        Logger.log("Processing drag drop - isBookmarkOnly:", isBookmarkOnly);

        try {
            let tab;
            let tabId;

            if (isBookmarkOnly) {
                // For bookmark-only tabs, create a synthetic tab object from DOM data
                const titleElement = draggingElement.querySelector('.tab-title-display');
                tab = {
                    id: null,
                    url: draggingElement.dataset.url,
                    title: titleElement ? titleElement.textContent : 'Untitled',
                    favIconUrl: null
                };
                tabId = null;
                Logger.log("Created synthetic tab object for bookmark-only:", tab);
            } else {
                // For regular tabs, fetch the actual tab object
                tabId = parseInt(draggingElement.dataset.tabId);
                tab = await chrome.tabs.get(tabId);
                Logger.log("Fetched real tab object:", tab);
            }
            const spaceElement = container.closest('.space');
            if (!spaceElement) {
                Logger.error('Could not find parent space element');
                return;
            }

            const spaceId = spaceElement.dataset.spaceId;
            const space = spaces.find(s => s.id === spaceId);

            if (!space) {
                Logger.error(`Space not found for ID: ${spaceId}`);
                return;
            }

            if (!tab) {
                Logger.error(`Tab not found for ID: ${tabId}`);
                return;
            }

            // Determine the target folder
            const targetFolderElement = targetFolder ? targetFolder.closest('.folder') : null;

            const spaceFolder = await getSpaceBookmarkFolder(space);
            if (targetFolderElement && !targetFolderElement.dataset.bookmarkId) throw new Error('Folder creation is not complete.');
            let bookmarkId = draggingElement.dataset.bookmarkId;
            const pinnedUrl = draggingElement.dataset.pinnedUrl || tab.url;
            if (!dropIntent?.bookmarkSourceContent || !dropIntent?.bookmarkTargetContent) {
                throw new Error('Bookmark drop context is unavailable. Refresh and retry.');
            }
            const crossSpaceDrop = dropIntent.crossSpaceDrop;
            const source = crossSpaceDrop?.source;
            const sourceRootId = source && bookmarkId ? (await getSpaceBookmarkFolder(source)).id : undefined;
            const original = sourceRootId ? (await chrome.bookmarks.get(bookmarkId))[0] : null;
            const boundIds = sourceRootId ? await getTabsBoundToBookmark(source, bookmarkId) : [];
            const operation = makeBookmarkDropOperation({
                sourceContent: dropIntent.bookmarkSourceContent,
                targetContent: dropIntent.bookmarkTargetContent,
                draggingElement,
                rootId: spaceFolder.id,
                sourceRootId,
                tab
            });
            if (crossSpaceDrop) {
                const folderId = bookmarkParentIdForContent(dropIntent.bookmarkTargetContent, spaceFolder.id);
                operation.bookmarkRoots = [{ folderId, rootId: spaceFolder.id }];
                if (original) operation.bookmarkRoots.push({ folderId: original.parentId, rootId: sourceRootId });
            }
            let result;
            try {
                result = await saveBookmarkOperation(operation);
            } catch (error) {
                if (crossSpaceDrop && error.moved) {
                    rememberBookmarkRelocation(crossSpaceDrop, operation.relocation, error.createdId || bookmarkId, original, sourceRootId);
                }
                throw error;
            }
            bookmarkId = result.createdId || bookmarkId;
            if (crossSpaceDrop) rememberBookmarkRelocation(crossSpaceDrop, operation.relocation, bookmarkId, original, sourceRootId);
            for (const [id, order] of Object.entries(result.orders || {})) bookmarkOrderBaselines.set(String(id), order.map(String));
            draggingElement.dataset.bookmarkId = bookmarkId;
            draggingElement.dataset.pinnedUrl = pinnedUrl;
            if (crossSpaceDrop) {
                if (tabId) await setDropPinBinding(crossSpaceDrop, tabId, { bookmarkId, pinnedUrl });
                for (const id of new Set([...boundIds, ...(tabId ? [tabId] : [])])) {
                    transferDraggedTab(crossSpaceDrop, space, id, 'spaceBookmarks');
                }
            } else if (!isBookmarkOnly && tabId) {
                await Utils.setPinnedTabState(tabId, { bookmarkId, pinnedUrl });
                space.temporaryTabs = space.temporaryTabs.filter(id => id !== tabId);
                if (!space.spaceBookmarks.includes(tabId)) {
                    space.spaceBookmarks.push(tabId);
                }
                Logger.log("Updated space data for regular tab:", tabId);
            } else {
                Logger.log("Skipping space data update for bookmark-only tab");
            }

            // Remove a closed placeholder for the same bookmark after dropping an open tab.
            container.querySelectorAll('.tab.bookmark-only').forEach(el => {
                if (el !== draggingElement && el.dataset.bookmarkId === bookmarkId) el.remove();
            });

            // Update all folder placeholders after bookmark operations
            updatePinnedSectionPlaceholders();
        } catch (error) {
            Logger.error('Error handling pinned tab drop:', error);
            updatePinnedSectionPlaceholders();
            throw error;
        }
    } else if (container.dataset.tabType === 'temporary' && draggingElement.dataset.tabId) {
        // Handle favorite tab conversion
        if (draggingElement.classList.contains('pinned-favicon')) {
            const { tab } = await convertFavoriteToTab(draggingElement, false);
            const space = spaces.find(s => s.id === activeSpaceId);
            if (space) await moveTabToSpace(tab.id, space.id, false);
            return; // Exit early, conversion complete
        }

        Logger.log("Tab dropped to temporary section");
        const tabId = parseInt(draggingElement.dataset.tabId);

        try {
            const tab = await chrome.tabs.get(tabId);
            const space = spaces.find(s => s.id === container.closest('.space')?.dataset.spaceId);
            const crossSpaceDrop = dropIntent?.crossSpaceDrop;

            if (space && tab) {
                if (crossSpaceDrop) {
                    const { source } = crossSpaceDrop;
                    if (source.spaceBookmarks.includes(tab.id)) {
                        const bookmarkId = draggingElement.dataset.bookmarkId;
                        const boundIds = await getTabsBoundToBookmark(source, bookmarkId);
                        const relatedTabs = boundIds.filter(id => id !== tab.id)
                            .map(id => ({ id, index: source.spaceBookmarks.indexOf(id) }));
                        for (const id of new Set([...boundIds, tab.id])) {
                            await setDropPinBinding(crossSpaceDrop, id, null);
                            if (id !== tab.id) transferDraggedTab(crossSpaceDrop, source, id, 'temporaryTabs');
                        }
                        // Keep the bookmark until the new bindings and membership are durable.
                        crossSpaceDrop.unpins.push({ tab: { ...tab, bookmarkId }, relatedTabs });
                    }
                    transferDraggedTab(crossSpaceDrop, space, tab.id, 'temporaryTabs');
                    return { orderHandled: true };
                }
                // Remove tab from bookmarks if it exists
                if (space.spaceBookmarks.includes(tab.id)) {
                    const result = await moveTabToTemp(space, tab, {
                        temporaryDisplayOrder: dropIntent?.temporaryDisplayOrder,
                        inverted: dropIntent?.inverted,
                        refresh: false,
                        offerUndo: dropIntent?.offerUndo !== false
                    });
                    return { orderHandled: true, removedFavorite: result?.removed };

                }

                // Update all folder placeholders after removing bookmark
                updatePinnedSectionPlaceholders();
            }
        } catch (error) {
            Logger.error('Error handling temporary tab drop:', error);
            updatePinnedSectionPlaceholders();
            throw error;
        }
    } else if (draggingElement && draggingElement.classList.contains('pinned-favicon') && draggingElement.dataset.tabId) {
        const tabId = parseInt(draggingElement.dataset.tabId);
        try {
            // 1. Unpin the tab from Chrome favorites
            await chrome.tabs.update(tabId, { pinned: false });

            // Update all folder placeholders after conversion
            updatePinnedSectionPlaceholders();
        } catch (error) {
            Logger.error('Error converting favorite tab to space tab:', error);
            updatePinnedSectionPlaceholders();
            throw error;
        }
    }
    return { orderHandled: false };
}

// Order belongs to extension data; Chrome's tab-strip order is irrelevant.
async function persistSpaceTabOrder(spaceId, { dropDestination, dropTransfers, dropParentId } = {}) {
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return;
    space.spaceBookmarks = uniqPreserveOrder(space.spaceBookmarks);
    space.temporaryTabs = uniqPreserveOrder(space.temporaryTabs.filter(id => !space.spaceBookmarks.includes(id)));
    return saveSpaces(dropDestination ? { dropDestination, dropTransfers, dropParentId } : undefined);
}

/**
 * Called after an Arcify drag+drop to update the space model (spaceBookmarks/temporaryTabs)
 * from the DOM and persist the extension order.
 */
async function handleArcifyOrderChangeAfterDrop(container, condition) {
    if (!container) return;
    const spaceElement = container.closest('.space');
    if (!spaceElement) return;
    const spaceId = spaceElement.dataset.spaceId;
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return;

    const tabType = container.dataset.tabType;
    const invertTabOrder = await Utils.getInvertTabOrder();
    if (tabType === 'temporary') {
        // DOM order is display order (top->bottom). Canonical storage is extension order (left->right).
        const tempIdsDisplayOrder = getTempSectionTabIds(spaceElement);
        const tempIdsChromeOrder = invertTabOrder ? [...tempIdsDisplayOrder].reverse() : tempIdsDisplayOrder;
        // Preserve any non-rendered temp ids (should be rare), append to end.
        space.temporaryTabs = mergeVisibleOrder(space.temporaryTabs ?? [], tempIdsChromeOrder);
    } else if (tabType === 'pinned') {
        // DOM order is display order. Canonical storage is extension order.
        const pinnedIdsDisplayOrder = getFlattenedPinnedSectionTabIds(spaceElement);
        // Favorites always render in bookmark order; invertTabOrder applies to temporary tabs only.
        space.spaceBookmarks = mergeVisibleOrder(space.spaceBookmarks ?? [], pinnedIdsDisplayOrder);
    } else {
        return;
    }

    return persistSpaceTabOrder(spaceId, condition);
}

async function setupDragAndDrop(pinnedContainer, tempContainer) {
    Logger.log('Setting up drag and drop handlers...');
    [pinnedContainer, tempContainer].forEach(container => {
        addDragListener(container, 'dragover', e => {
            e.preventDefault();
            const draggingElement = document.querySelector('.dragging');
            if (draggingElement) {
                const targetFolder = getDropTargetFolderContent(e.target, draggingElement);
                const targetContainer = targetFolder || container;
                if (isInvalidDrop(draggingElement, container, targetContainer)) {
                    tabDragPreview.clear();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
                    hideAllDropIndicators();
                    clearFolderOpenTimer();
                    return;
                }

                // Check for collapsed folder auto-open functionality
                const folderElement = e.target.closest('.folder');
                if (folderElement && folderElement.classList.contains('collapsed') && !draggingElement.contains(folderElement)) {
                    // Start timer to auto-open collapsed folder if hovering over it
                    if (currentHoveredFolder !== folderElement) {
                        startFolderOpenTimer(folderElement);
                    }
                } else {
                    // Clear timer if not hovering over a collapsed folder
                    clearFolderOpenTimer();
                }

                // Preview placement in layout without changing any real row's
                // parent/order. Native Favorites and folders retain their indicators.
                if (draggingElement.classList.contains('tab') && tabDragPreview.move(targetContainer, e.clientY)) {
                    hideAllDropIndicators();
                    return;
                }

                // Get the element we're dragging over to show drop indicator
                const afterElement = getDragAfterElementTabs(targetContainer, e.clientY);
                if (afterElement && targetContainer.contains(afterElement)) {
                    // Check if this is a placeholder (empty container)
                    if (afterElement.classList.contains('tab-placeholder')) {
                        // Show visual feedback on the placeholder itself
                        afterElement.classList.add('drag-over');
                        hideAllDropIndicators(); // Don't show traditional indicators for placeholders
                    } else {
                        // Show traditional drop indicators for actual tabs/folders
                        const position = getDropPosition(afterElement, e.clientX, e.clientY, false);
                        showDropIndicator(afterElement, position, false);
                        // Remove any placeholder drag-over state in this container
                        const placeholder = targetContainer.querySelector('.tab-placeholder');
                        if (placeholder) placeholder.classList.remove('drag-over');
                    }
                } else {
                    // If no specific element, hide indicators
                    hideAllDropIndicators();
                    // Remove any placeholder drag-over state in this container
                    const placeholder = targetContainer.querySelector('.tab-placeholder');
                    if (placeholder) placeholder.classList.remove('drag-over');
                }

                // Note: Actual bookmark operations moved to drop event for proper architecture
            }
        });

        // Add dragleave handler to hide indicators when leaving container
        addDragListener(container, 'dragleave', e => {
            // Only hide indicators if we're actually leaving the container (not moving to a child)
            if (!container.contains(e.relatedTarget)) {
                hideAllDropIndicators();
                // Remove any placeholder drag-over state in this container
                const placeholder = container.querySelector('.tab-placeholder');
                if (placeholder) placeholder.classList.remove('drag-over');
                // Clear folder auto-open timer when leaving the container
                clearFolderOpenTimer();
            }
        });

        // Add drop handler to position elements and hide indicators
        addDragListener(container, 'drop', async e => {
            e.preventDefault();
            hideAllDropIndicators();
            // Remove any placeholder drag-over state in this container
            const placeholder = container.querySelector('.tab-placeholder');
            if (placeholder) placeholder.classList.remove('drag-over');
            // Clear folder auto-open timer on drop
            clearFolderOpenTimer();

            const draggingElement = document.querySelector('.dragging');
            if (draggingElement) {
                const previewDrop = tabDragPreview.takeDrop(container);
                pendingMutationCount++;
                const removedFavorites = [];
                const spaceElement = container.closest('.space');
                const sourceSpaceId = draggingElement.closest('.space')?.dataset.spaceId;
                const destinationSpaceId = spaceElement?.dataset.spaceId;
                const sourceSpace = sourceSpaceId !== destinationSpaceId
                    ? spaces.find(space => space.id === sourceSpaceId)
                    : null;
                const crossSpaceDrop = sourceSpace ? { source: sourceSpace, rollbacks: [], transfers: new Map(), unpins: [] } : null;
                let crossSpaceSaved = false;
                try {
                if (sourceSpace && spaceDragPreview?.element !== spaceElement) return;
                if (container.dataset.tabType === 'pinned' && spaceElement?.dataset.bookmarkTreeUnavailable === 'true') {
                    throw new Error('Favorites are unavailable until this space bookmark folder is restored.');
                }
                // Resolve the folder content (if any) that receives this drop.
                const targetFolder = previewDrop
                    ? (previewDrop.container === container ? null : previewDrop.container)
                    : getDropTargetFolderContent(e.target, draggingElement);
                const targetFolderElement = targetFolder?.closest('.folder');
                if (isInvalidDrop(draggingElement, container, targetFolder || container)) return;
                tabDropCommitting = true;
                const draggingElements = draggingTabIds.length > 1 && !draggingElement.classList.contains('folder')
                    ? getOrderedTabElementsById(draggingTabIds) : [draggingElement];
                const targetContainer = targetFolder || container;
                const foldersToOpen = [...dragOpenedFolders].filter(folder => folder.contains(targetContainer));
                if (targetFolderElement && !foldersToOpen.includes(targetFolderElement)) foldersToOpen.push(targetFolderElement);
                const sourceFolders = new Set(draggingElements.map(el => el.classList.contains('folder')
                    ? el.parentElement.closest('.folder') : el.closest('.folder')).filter(Boolean));
                const originalFavorites = new Map();
                if ((sourceSpace || draggingElements.length > 1) && container.dataset.tabType === 'temporary') {
                    for (const element of draggingElements) {
                        const tabId = Number(element.dataset.tabId);
                        const source = ownerOf(spaces, tabId);
                        if (!source?.spaceBookmarks.includes(tabId)) continue;
                        const binding = await Utils.getPinnedTabState(tabId);
                        const bookmark = await getSpaceBookmarkById(source, binding?.bookmarkId);
                        if (!bookmark) throw new Error('The selected favorite no longer belongs to this space.');
                        originalFavorites.set(tabId, {
                            index: bookmark.index, favoriteIndex: source.spaceBookmarks.indexOf(tabId), spaceId: source.id,
                            fromSpaceId: destinationSpaceId
                        });
                    }
                }
                const afterElement = previewDrop ? null : getDragAfterElementTabs(targetContainer, e.clientY);
                let insertBefore = previewDrop?.before || null;
                if (afterElement && targetContainer.contains(afterElement)) {
                    if (afterElement.classList.contains('tab-placeholder')) {
                        afterElement.classList.add('hidden');
                    } else {
                        insertBefore = getDropPosition(afterElement, e.clientX, e.clientY, false) === 'above'
                            ? afterElement : afterElement.nextElementSibling;
                        while (insertBefore && draggingElements.includes(insertBefore)) insertBefore = insertBefore.nextElementSibling;
                    }
                }
                const dropInverted = await Utils.getInvertTabOrder();
                tabDragPreview.finish();
                let orderHandled = false;
                const droppedFolder = draggingElement.classList.contains('folder');
                for (const element of draggingElements) {
                    const originalContent = element.parentElement;
                    const sourceFolder = element.classList.contains('folder')
                        ? element.parentElement.closest('.folder') : element.closest('.folder');
                    const sourceContent = sourceFolder?.querySelector(':scope > .folder-content');
                    removeProjectedAnchor(sourceContent, element);
                    targetContainer.insertBefore(element, insertBefore);
                    if (originalContent.classList.contains('favorite-tile')) originalContent.remove();
                    const dropIntent = container.dataset.tabType === 'temporary'
                        ? { crossSpaceDrop, temporaryDisplayOrder: getTempSectionTabIds(spaceElement), inverted: dropInverted, offerUndo: draggingElements.length === 1 }
                        : {
                            crossSpaceDrop,
                            bookmarkSourceContent: element.dataset.bookmarkId ? (sourceContent || originalContent) : targetContainer,
                            bookmarkTargetContent: targetContainer
                        };
                    const result = await handleBookmarkOperations(e, element, container, targetFolder, dropIntent);
                    const tabId = Number(element.dataset.tabId);
                    if (result?.removedFavorite && originalFavorites.has(tabId)) {
                        removedFavorites.push({ ...result.removedFavorite, ...originalFavorites.get(tabId), tabId, relatedTabs: result.relatedTabs });
                    }
                    orderHandled ||= Boolean(result?.orderHandled);
                }
                // Persist ownership before removing bookmarks from cross-space unpins.
                if (crossSpaceDrop) {
                    const dropTransfers = [...crossSpaceDrop.transfers];
                    let saved;
                    let saveError;
                    try {
                        saved = await handleArcifyOrderChangeAfterDrop(container, {
                            dropDestination: destinationSpaceId, dropTransfers,
                            dropParentId: targetFolderElement?.dataset.bookmarkId
                        });
                    } catch (error) {
                        saveError = error;
                        ({ spaces: saved } = await chrome.storage.local.get('spaces'));
                        if (!dropTransfers.length) throw error;
                    }
                    if (!saved?.some(space => space.id === destinationSpaceId)) {
                        throw saveError || new Error('The drop destination is no longer available.');
                    }
                    const unassigned = new Set(dropTransfers.filter(([id, { spaceId, section }]) =>
                        !saved.find(space => space.id === spaceId)?.[section].includes(id)).map(([id]) => id));
                    if (unassigned.size) {
                        const liveTabs = await chrome.tabs.query({}).catch(error => {
                            // The ownership write may already be durable. Do not
                            // reverse it or delete any bookmark on an uncertain read.
                            crossSpaceSaved = true;
                            throw error;
                        });
                        if (liveTabs.some(tab => unassigned.has(tab.id))) {
                            throw saveError || new Error('A tab could not be moved to the destination Space.');
                        }
                    }
                    crossSpaceSaved = true;
                    for (const { tab, relatedTabs } of crossSpaceDrop.unpins) {
                        const live = await chrome.tabs.get(tab.id).catch(error => {
                            if (/No tab with id:/i.test(error.message)) return null;
                            throw error;
                        });
                        if (!live) continue;
                        const removed = await removeSpacePin(sourceSpace, tab);
                        if (!removed) throw new Error('The tabs were moved, but a saved bookmark could not be removed.');
                        removedFavorites.push({ ...removed, ...originalFavorites.get(tab.id), tabId: tab.id, relatedTabs });
                    }
                }
                for (const folder of sourceFolders) syncCollapsedFolderTabs(folder);
                for (const folder of foldersToOpen) {
                    if (dragOpenedFolders.delete(folder)) {
                        await saveFolderCollapsed(folder.dataset.bookmarkId, false)
                            .catch(error => Logger.warn('Could not save opened folder state:', error));
                    } else openFolder(folder);
                }
                if (targetFolderElement && !sourceFolders.has(targetFolderElement)) {
                    syncCollapsedFolderTabs(targetFolderElement);
                }
                // The final DOM order includes all moved rows, including temporary tabs
                // that have no bookmark operation of their own.
                if (!crossSpaceDrop && (droppedFolder || draggingElements.length > 1 || !orderHandled)) {
                    await handleArcifyOrderChangeAfterDrop(container);
                }
                if (sourceSpace) await setActiveSpace(destinationSpaceId, false, { source: 'drop' });
                if (orderHandled) await refreshActiveSpaceUI({ force: true });
                } catch (error) {
                    Logger.warn('Drop could not be completed; restoring saved state.', error);
                    if (crossSpaceDrop && !crossSpaceSaved) {
                        for (const rollback of crossSpaceDrop.rollbacks.reverse()) {
                            await rollback().catch(failure => Logger.warn('Could not restore the previous bookmark or binding:', failure));
                        }
                        await spaceRequest('get', { discoverBookmarks: false })
                            .then(current => adoptStoredSpaces(current, { render: false }))
                            .catch(failure => Logger.warn('Could not reload Space membership:', failure));
                    }
                    if (crossSpaceSaved && activeSpaceId !== destinationSpaceId) {
                        await setActiveSpace(destinationSpaceId, false, { source: 'drop' })
                            .catch(failure => Logger.warn('Could not show the destination Space:', failure));
                    }
                    if (sourceSpace) endSpaceDragPreview();
                    await refreshActiveSpaceUI({ force: true });
                    alert(error.message);
                } finally {
                    tabDragPreview.finish();
                    tabDropCommitting = false;
                    endSpaceDragPreview();
                    restoreDragFolders();
                    offerFavoritesUndo(removedFavorites);
                    pendingMutationCount--;
                    refreshCoordinator.schedule();
                }
            }
        });
    });
}

// Function to set up drag and drop for placeholder containers to make entire placeholder area droppable
function setupPlaceholderDragAndDrop(placeholderContainer, pinnedContainer) {
    Logger.log('Setting up placeholder drag and drop handlers...');

    addDragListener(placeholderContainer, 'dragover', e => {
        e.preventDefault();
        const draggingElement = document.querySelector('.dragging');
        if (draggingElement) {
            // Check if pinned container is empty (no tabs or folders, only placeholder)
            const hasContent = pinnedContainer.querySelectorAll('.tab:not(.tab-placeholder), .folder').length > 0;

            if (!hasContent) {
                if (draggingElement.classList.contains('tab') && tabDragPreview.move(pinnedContainer, e.clientY)) {
                    hideAllDropIndicators();
                    return;
                }
                // Container is empty - show visual feedback on placeholder
                const placeholder = placeholderContainer.querySelector('.tab-placeholder');
                if (placeholder) {
                    placeholder.classList.add('drag-over');
                }
                hideAllDropIndicators();
            }
        }
    });

    addDragListener(placeholderContainer, 'dragleave', e => {
        // Only hide if leaving the placeholder container entirely
        if (!placeholderContainer.contains(e.relatedTarget)) {
            const placeholder = placeholderContainer.querySelector('.tab-placeholder');
            if (placeholder) {
                placeholder.classList.remove('drag-over');
            }
        }
    });

    addDragListener(placeholderContainer, 'drop', async e => {
        e.preventDefault();
        const placeholder = placeholderContainer.querySelector('.tab-placeholder');
        if (placeholder) {
            placeholder.classList.remove('drag-over');
        }
        hideAllDropIndicators();

        const draggingElement = document.querySelector('.dragging');
        if (draggingElement) {
            // Check if pinned container is empty
            const hasContent = pinnedContainer.querySelectorAll('.tab:not(.tab-placeholder), .folder').length > 0;

            if (!hasContent) {
                // Forward the drop to the pinned container by simulating the drop event
                Logger.log('Forwarding placeholder drop to pinned container');

                // Create a synthetic drop event for the pinned container
                dispatchPointerDrag(pinnedContainer, 'drop', {
                    dataTransfer: e.dataTransfer,
                    clientX: e.clientX,
                    clientY: e.clientY
                });
            }
        }
    });
}

const folderNameEditors = new WeakMap();

function setupFolderNameEditor(folderElement, folder, initialSession = null) {
    const header = folderElement.querySelector(':scope > .folder-header');
    const title = header.querySelector('.folder-title');
    const input = header.querySelector('.folder-name');
    const toggle = header.querySelector('.folder-toggle');
    let savedName = folder.title;
    let editSession = initialSession;

    function showSavedName() {
        input.value = savedName;
        input.disabled = true;
        input.readOnly = true;
        input.style.display = 'none';
        title.textContent = savedName;
        toggle.setAttribute('aria-label', savedName);
        title.style.display = 'inline';
    }

    function startEdit({ blank = false } = {}) {
        if (!folderElement.isConnected || editSession?.completion) return;
        if (!editSession) editSession = editorSessions.begin('folder', folder.id);
        if (input.disabled) input.value = blank ? '' : savedName;
        title.style.display = 'none';
        input.style.display = 'inline-block';
        input.disabled = false;
        input.readOnly = false;
        input.focus();
        input.select();
    }

    async function finishEdit(save) {
        const session = editSession;
        if (!session) return;
        const name = input.value.trim();
        try {
            await editorSessions.complete(session, async () => {
                if (save && name && name !== savedName) {
                    await chrome.bookmarks.update(folder.id, { title: name });
                    savedName = name;
                }
                showSavedName();
            });
        } catch (error) {
            showSavedName();
            Logger.error('Error updating folder name:', error);
            alert(error.message);
        } finally {
            if (editSession === session) editSession = null;
        }
    }

    header.addEventListener('click', event => {
        if (event.target !== input) setFolderCollapsed(folderElement, !folderElement.classList.contains('collapsed'));
    });
    header.addEventListener('dblclick', event => {
        if (event.target !== toggle && event.target !== input) startEdit();
    });
    input.addEventListener('blur', () => finishEdit(true));
    input.addEventListener('keydown', async event => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return;
        event.preventDefault();
        await finishEdit(event.key === 'Enter');
        input.blur();
    });
    showSavedName();
    folderNameEditors.set(folderElement, startEdit);
    return startEdit;
}

async function createNewFolder(spaceElement, parentFolderElement = null) {
    const space = spaces.find(s => s.id === spaceElement.dataset.spaceId);
    const spaceFolder = await getSpaceBookmarkFolder(space);
    const parentId = parentFolderElement?.dataset.bookmarkId || spaceFolder.id;
    if (parentFolderElement && !parentFolderElement.dataset.bookmarkId) return;
    if (!await canCreateFolder(spaceFolder.id, parentId)) return;
    const pinnedContainer = parentFolderElement
        ? parentFolderElement.querySelector(':scope > .folder-content')
        : spaceElement.querySelector('[data-tab-type="pinned"]');
    setPinnedSectionCollapsed(spaceElement, false);
    if (parentFolderElement) openFolder(parentFolderElement);
    const folderTemplate = document.getElementById('folderTemplate');
    const newFolder = folderTemplate.content.cloneNode(true);
    const folderElement = newFolder.querySelector('.folder');
    setFolderCollapsed(folderElement, false, false);

    setupFolderDragHandlers(folderElement);

    const pendingEditor = editorSessions.begin('folder-pending', space.id);
    try {
        const folder = await createFolder(spaceFolder.id, parentId, 'Untitled');
        folderElement.dataset.bookmarkId = folder.id;
        await saveFolderCollapsed(folder.id, false);
        if (pendingEditor.disposed || activeSpaceId !== space.id || !spaceElement.isConnected) {
            await editorSessions.complete(pendingEditor);
            return;
        }
        editorSessions.setOwner(pendingEditor, 'folder', folder.id);
        const startEdit = setupFolderNameEditor(folderElement, folder, pendingEditor);
        setupFolderContextMenu(folderElement, space);
        pinnedContainer.appendChild(folderElement);
        if (parentFolderElement) updateFolderPlaceholder(parentFolderElement);
        updateFolderPlaceholder(folderElement);
        startEdit({ blank: true });
    } catch (error) {
        await editorSessions.complete(pendingEditor);
        alert(error.message);
    }
}

const spaceRenderTasks = new Map();
async function loadTabs(space, pinnedContainer, tempContainer, options = {}) {
    const previous = spaceRenderTasks.get(space.id) || Promise.resolve();
    const run = previous.catch(error => Logger.warn('Previous space render failed', error)).then(async () => {
        if (!pinnedContainer.isConnected) return;
        return renderSpaceTabs(space, pinnedContainer, tempContainer, options);
    });
    spaceRenderTasks.set(space.id, run);
    try { return await run; }
    finally { if (spaceRenderTasks.get(space.id) === run) spaceRenderTasks.delete(space.id); }
}

async function renderSpaceTabs(space, pinnedContainer, tempContainer, { force = false } = {}) {
    Logger.log('Loading tabs for space:', space.id);
    Logger.log('Space bookmarks in space:', space.spaceBookmarks);
    const representedPinnedTabIds = new Set();
    const invertTabOrder = await Utils.getInvertTabOrder();
    const tabs = (await getOwnedTabs(space.id)).filter(t => !t.pinned);
    const pinnedStatesById = await Utils.getPinnedTabStates();
    const pinNameDefaults = await getSpacePinNameDefaults();
    const pinnedFragment = document.createDocumentFragment();
    let treeAvailable = true;
    let treeLoaded = false;

    try {
        const spaceFolder = await getSpaceBookmarkTree(space);
        treeLoaded = true;
        if (spaceFolder) {
            // Recursive function to process bookmarks and folders
            async function processBookmarkNode(node, container) {
                const bookmarks = node.children || [];
                bookmarkOrderBaselines.set(String(node.id), bookmarks.map(item => String(item.id)));
                Logger.log('Processing bookmarks:', bookmarks);

                // Favorites follow bookmark order; invertTabOrder applies to temporary tabs only.
                for (const item of bookmarks) {
                    if (!item.url) {
                        // This is a folder
                        const folderTemplate = document.getElementById('folderTemplate');
                        const newFolder = folderTemplate.content.cloneNode(true);
                        const folderElement = newFolder.querySelector('.folder');
                        folderElement.dataset.bookmarkId = item.id;
                        setupFolderNameEditor(folderElement, item);
                        setupFolderContextMenu(folderElement, space);
                        setupFolderDragHandlers(folderElement);

                        container.appendChild(folderElement);

                        // Recursively process the folder's contents
                        await processBookmarkNode(item, folderElement.querySelector('.folder-content'));

                        // Update folder placeholder state after loading contents
                        updateFolderPlaceholder(folderElement);
                        // Restore parent and child states independently after their contents render.
                        setFolderCollapsed(folderElement, await loadFolderCollapsed(item.id), false);
                    } else {
                        // This is a bookmark
                        {
                            const existingTab = tabs.find(t =>
                                !representedPinnedTabIds.has(t.id) &&
                                pinnedStatesById[t.id]?.bookmarkId === item.id);
                            if (existingTab) {
                                Logger.log('Creating UI element for active bookmark:', existingTab);
                                representedPinnedTabIds.add(existingTab.id);
                                existingTab.pinnedUrl = item.url;
                                existingTab.bookmarkId = item.id;
                                existingTab.pinAlias = typeof pinNameDefaults[item.id] === 'string' ? item.title : '';
                                const tabElement = await createTabElement(existingTab, true);
                                Logger.log('Appending tab element to container:', tabElement);
                                container.appendChild(tabElement);
                            } else {
                                // Create UI element for inactive bookmark
                                const bookmarkTab = {
                                    id: null,
                                    title: item.title,
                                    url: item.url,
                                    favIconUrl: null,
                                    spaceName: space.name,
                                    pinnedUrl: item.url,
                                    bookmarkId: item.id
                                };
                                Logger.log('Creating UI element for inactive bookmark:', item);
                                const tabElement = await createTabElement(bookmarkTab, true, true);
                                container.appendChild(tabElement);
                            }
                            // Update placeholder state for folder if this container is inside a folder
                            const parentFolder = container.closest?.('.folder');
                            if (parentFolder) {
                                updateFolderPlaceholder(parentFolder);
                            }
                        }
                    }
                }
                return;
            }

            // Process the space folder and get all bookmarked URLs
            await processBookmarkNode(spaceFolder, pinnedFragment);
        }
    } catch (error) {
        if (treeLoaded) throw error;
        treeAvailable = false;
        Logger.warn('Bookmark tree unavailable; rendering live tabs only:', error);
        const notice = document.createElement('div');
        notice.className = 'bookmark-association-error';
        notice.textContent = 'Favorites are temporarily unavailable. Your bookmarks were not changed. ';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'sidebar-text-action';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => scheduleBookmarkRefresh());
        notice.appendChild(retry);
        pinnedFragment.appendChild(notice);
    }

    const tempFragment = document.createDocumentFragment();
    const unrepresentedBookmarkIds = space.spaceBookmarks.filter(id => !representedPinnedTabIds.has(id));
    const fallbackFavoriteIds = treeAvailable ? [] : unrepresentedBookmarkIds;
    const temporaryTabIds = [...new Set([...space.temporaryTabs, ...unrepresentedBookmarkIds])]
        .filter(id => !fallbackFavoriteIds.includes(id));
    if (invertTabOrder) temporaryTabIds.reverse();
    const tabsToLoad = [...new Set([...fallbackFavoriteIds, ...temporaryTabIds])];
    for (const tabId of tabsToLoad) {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab || representedPinnedTabIds.has(tabId)) continue;
        const isFavoriteFallback = !treeAvailable && space.spaceBookmarks.includes(tabId);
        if (isFavoriteFallback) {
            tab.bookmarkId = pinnedStatesById[tabId]?.bookmarkId;
            tab.pinnedUrl = pinnedStatesById[tabId]?.pinnedUrl;
        }
        const tabElement = await createTabElement(tab, isFavoriteFallback);
        if (isFavoriteFallback) {
            tabElement.classList.add('favorite-fallback');
            tabElement.draggable = false;
            tabElement.title = 'Favorite controls are unavailable until the bookmark folder is restored.';
            const blockUnavailableMutation = event => {
                event.preventDefault();
                event.stopImmediatePropagation();
            };
            tabElement.addEventListener('contextmenu', blockUnavailableMutation, { capture: true });
            tabElement.addEventListener('dblclick', blockUnavailableMutation, { capture: true });
        }
        tempFragment.appendChild(tabElement);
    }

    // Earlier rows were built before later asynchronous bookmark/title work.
    // Reconcile the completed fragments together immediately before committing,
    // so a native audio event cannot be lost when an old projection is replaced.
    const audioTabs = new Map((await tabAudioEvents.read(
        () => chrome.tabs.query({ windowId: currentWindow.id }), true)).map(tab => [tab.id, tab]));
    for (const fragment of [pinnedFragment, tempFragment]) {
        for (const element of fragment.querySelectorAll('.tab[data-tab-id]')) {
            const tab = audioTabs.get(Number(element.dataset.tabId));
            if (tab) updateTabAudioIndicator(element, tab);
            else element.remove();
        }
    }

    if (editorSessions.isActive() || (!force && (isDraggingTab || pendingMutationCount > 0))) {
        refreshCoordinator.invalidateSpaces();
        return false;
    }

    pinnedContainer.querySelectorAll('.tab, .folder, .bookmark-association-error').forEach(el => {
        disposeEditorsInElement(el);
        el.remove();
    });
    tempContainer.querySelectorAll('.tab').forEach(el => {
        disposeEditorsInElement(el);
        el.remove();
    });
    pinnedContainer.appendChild(pinnedFragment);
    tempContainer.appendChild(tempFragment);
    const spaceElement = pinnedContainer.closest('.space');
    if (spaceElement) {
        spaceElement.dataset.bookmarkTreeUnavailable = treeAvailable ? 'false' : 'true';
        reconcileCleanPreview(spaceElement);
    }
    return true;
}

// Debounced UI refresh when settings change (e.g., invertTabOrder)
let refreshActiveSpaceUITimeout = null;

async function refreshActiveSpaceUI({ force = false } = {}) {
    if (!force && (editorSessions.isActive() || isDraggingTab || pendingMutationCount > 0)) {
        refreshCoordinator.invalidateSpaces();
        return false;
    }
    try {
        if (!activeSpaceId) return true;
        const space = spaces.find(s => s.id === activeSpaceId);
        if (!space) return true;

        const spaceElement = document.querySelector(`[data-space-id="${activeSpaceId}"]`);
        if (!spaceElement) return true;

        const pinnedContainer = spaceElement.querySelector('[data-tab-type="pinned"]');
        const tempContainer = spaceElement.querySelector('[data-tab-type="temporary"]');
        if (!pinnedContainer || !tempContainer) return true;

        if (await loadTabs(space, pinnedContainer, tempContainer, { force }) === false) return false;
        updatePinnedSectionPlaceholders();

        // Restore active highlight if possible
        const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTabs?.length) {
            activateTabInDOM(activeTabs[0].id);
        }
        return true;
    } catch (e) {
        Logger.warn('[UIRefresh] Error refreshing active space UI:', e);
        throw e;
    }
}

function setPinnedSectionCollapsed(spaceElement, collapsed, persist = true) {
    const pinnedSection = spaceElement.querySelector('.pinned-tabs');
    const heading = spaceElement.querySelector('.space-toggle-chevron');
    pinnedSection.hidden = collapsed;
    pinnedSection.classList.toggle('collapsed', collapsed);
    heading.classList.toggle('collapsed', collapsed);
    heading.setAttribute('aria-expanded', String(!collapsed));
    if (persist) localStorage.setItem(`space-${spaceElement.dataset.spaceId}-pinned-collapsed`, String(collapsed));
}

async function closeTab(tabElement, tab, isPinned = false, isBookmarkOnly = false) {
    Logger.log('Closing tab:', tab, tabElement, isPinned, isBookmarkOnly);

    if (isBookmarkOnly) {
        const space = spaces.find(s => s.id === tabElement.closest('.space')?.dataset.spaceId);
        if (!space) return;
        offerFavoriteUndo(await removeSpacePin(space, { bookmarkId: tabElement.dataset.bookmarkId }));
        tabElement.remove();

        // Update folder placeholders after removing bookmark
        updatePinnedSectionPlaceholders();
        return;
    }

    // Closing a live tab never deletes its durable favorite. The removal listener
    // reconstructs the closed row from its exact bookmark identity.
    pendingMutationCount++;
    try {
        const space = ownerOf(spaces, tab.id);
        const persistentRow = Boolean(tabElement.dataset.bookmarkId || space?.spaceBookmarks.includes(tab.id));
        await withTabCloseMotion(tabElement, () => chrome.tabs.remove(tab.id), { collapse: !persistentRow });
    } catch (error) {
        Logger.warn('Could not close tab:', error);
    } finally {
        pendingMutationCount--;
        refreshCoordinator.schedule();
    }
}


function isAwayFromPin(url, pinnedUrl) {
    return Boolean(pinnedUrl && url && Utils.getPinnedUrlKey(url) !== Utils.getPinnedUrlKey(pinnedUrl));
}

function renderLiveTabLabel(row, tab, override, pinnedUrl = row.dataset.pinnedUrl) {
    const titleDisplay = row.querySelector('.tab-title-display');
    const titleInput = row.querySelector('.tab-title-input');
    const domainDisplay = row.querySelector('.tab-domain-display');
    const alias = row.dataset.pinAlias;
    const away = isAwayFromPin(tab.url, pinnedUrl);
    const liveTitle = tab.title || 'New Tab';
    const title = alias || (!away && override?.name) || liveTitle;
    titleDisplay.textContent = title;
    titleDisplay.title = alias && away && liveTitle !== alias ? liveTitle : '';
    titleInput.value = title;

    let domain = '';
    if (away) {
        try {
            const home = new URL(pinnedUrl).hostname;
            const current = new URL(tab.url).hostname;
            if (home && current !== home) domain = current;
        } catch { /* A tab may not have a normal site URL. */ }
    }
    domainDisplay.textContent = domain;
    domainDisplay.classList.remove('back-to-pinned');
    domainDisplay.style.display = domain ? 'block' : 'none';
}

async function createTabElement(tab, isPinned = false, isBookmarkOnly = false) {
    Logger.log('Creating tab element:', tab.id, 'IsBookmarkOnly:', isBookmarkOnly);

    // Get the template and clone it
    const template = document.getElementById('tabTemplate');
    const tabElement = template.content.cloneNode(true).querySelector('.tab');

    // Set up the tab element properties
    tabElement.draggable = true; // Enable dragging for all tabs (regular and bookmark-only)

    if (isBookmarkOnly) {
        tabElement.classList.add('inactive', 'bookmark-only');
        tabElement.dataset.url = tab.url;
        if (tab.pinnedUrl) tabElement.dataset.pinnedUrl = tab.pinnedUrl;
        if (tab.bookmarkId) tabElement.dataset.bookmarkId = tab.bookmarkId;
    } else {
        tabElement.dataset.tabId = tab.id;
        tabElement.dataset.url = tab.url;
        if (selectedTabIds.has(tab.id)) {
            tabElement.classList.add('multi-selected');
            tabElement.setAttribute('aria-selected', 'true');
        }
        if (tab.active) {
            tabElement.classList.add('active');
        }
    }

    // Get references to template elements
    const favicon = tabElement.querySelector('.tab-favicon');
    const tabDetails = tabElement.querySelector('.tab-details');
    const titleDisplay = tabElement.querySelector('.tab-title-display');
    const domainDisplay = tabElement.querySelector('.tab-domain-display');
    const titleInput = tabElement.querySelector('.tab-title-input');
    const actionButton = tabElement.querySelector('.tab-close');

    // Arc-like visual indicator: "/" shown next to favicon when pinned URL has changed.
    let urlChangedSlash = tabElement.querySelector('.tab-url-changed-slash');
    if (!urlChangedSlash) {
        urlChangedSlash = document.createElement('span');
        urlChangedSlash.className = 'tab-url-changed-slash';
        urlChangedSlash.textContent = '/';
        favicon.parentElement.insertAdjacentElement('afterend', urlChangedSlash);
    }

    // Track pinned URL + bookmarkId for Arc-like behavior (only for space-pinned, active tabs).
    let pinnedUrlForTab = null;
    if (isPinned && !isBookmarkOnly && tab?.id) {
        const stored = await Utils.getPinnedTabState(tab.id);
        pinnedUrlForTab = tab.pinnedUrl || stored?.pinnedUrl || tab.url;
        const bookmarkIdForTab = tab.bookmarkId || stored?.bookmarkId || null;
        tabElement.dataset.pinnedUrl = pinnedUrlForTab;
        if (bookmarkIdForTab) {
            tabElement.dataset.bookmarkId = bookmarkIdForTab;
            if (tab.pinAlias !== undefined) {
                tabElement.dataset.pinAlias = tab.pinAlias;
            } else {
                const defaults = await getSpacePinNameDefaults();
                if (typeof defaults[bookmarkIdForTab] === 'string') {
                    const [bookmark] = await chrome.bookmarks.get(bookmarkIdForTab).catch(() => []);
                    if (bookmark?.url && !isAwayFromPin(bookmark.url, pinnedUrlForTab)) tabElement.dataset.pinAlias = bookmark.title || '';
                }
            }
        }
    }

    // Set up favicon
    setSidebarFavicon(favicon, tab.url);
    favicon.draggable = false; // Drag the tab, never the favicon image URL.

    // Arc-like: clicking the favicon takes you back to the pinned URL (if navigated away).
    if (isPinned && !isBookmarkOnly) {
        const computePinnedUrl = async () => {
            const stored = tab?.id ? await Utils.getPinnedTabState(tab.id) : null;
            return tabElement.dataset.pinnedUrl || tab.pinnedUrl || stored?.pinnedUrl || tab.url || null;
        };

        // IMPORTANT: always prefer the dataset URL (kept fresh by handleTabUpdate) over the captured `tab.url`
        // to avoid stale comparisons after navigation.
        const computeCurrentUrl = () => tabElement.dataset.url || tab.url || null;

        const canBackToPinned = async () => {
            const pinnedUrl = await computePinnedUrl();
            return isAwayFromPin(computeCurrentUrl(), pinnedUrl);
        };

        const setBackButtonState = async () => {
            const enabled = await canBackToPinned();
            favicon.classList.toggle('pinned-back', enabled);
            favicon.title = enabled ? 'Back to Pinned URL' : '';
            urlChangedSlash.classList.toggle('visible', enabled);
        };

        await setBackButtonState();

        favicon.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!tab?.id) return;
            try {
                const pinnedUrl = await computePinnedUrl();
                if (!pinnedUrl) return;
                const current = await chrome.tabs.get(tab.id);
                if (!current?.url || current.url === pinnedUrl) return;
                await chrome.tabs.update(tab.id, { url: pinnedUrl, active: true });
            } catch (err) {
                Logger.warn('[PinnedTab] Failed to navigate back to pinned URL:', err);
            }
        });
    }

    // Set up action button
    actionButton.classList.remove('tab-close');
    actionButton.classList.add(isBookmarkOnly ? 'tab-remove' : 'tab-close');
    actionButton.innerHTML = isBookmarkOnly ? '−' : '×';
    actionButton.title = isBookmarkOnly ? 'Remove Bookmark' : 'Close Tab';
    actionButton.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (e.button !== MOUSE_BUTTON.LEFT) return;
        const activeSpace = spaces.find(s => s.id === activeSpaceId);
        Logger.log("activeSpace", activeSpace);
        const isCurrentlyPinned = activeSpace?.spaceBookmarks.includes(tab.id);
        await closeTab(tabElement, tab, isCurrentlyPinned, isBookmarkOnly);
    });

    // --- Function to update display based on overrides ---
    const updateDisplay = async () => {
        // For bookmark-only elements, just display the stored title
        if (isBookmarkOnly) {
            titleDisplay.textContent = tab.title || 'Bookmark'; // Use stored title
            titleDisplay.style.display = 'inline';
            titleInput.style.display = 'none';
            domainDisplay.style.display = 'none';
            return;
        }

        const overrides = await Utils.getTabNameOverrides();
        renderLiveTabLabel(tabElement, tab, overrides[tab.id]);

        // Ensure correct elements are visible
        titleDisplay.style.display = 'inline'; // Or 'block' if needed
        titleInput.style.display = 'none';
    };

    // --- Event Listeners for Editing (Only for actual tabs) ---
    if (!isBookmarkOnly) {
        let tabEditSession = null;
        let initialName = '';
        tabDetails.addEventListener('dblclick', (e) => {
            // Prevent dblclick on favicon or close button from triggering rename
            if (e.target === favicon || e.target === actionButton) return;

            titleDisplay.style.display = 'none';
            domainDisplay.style.display = 'none'; // Hide domain while editing
            titleInput.style.display = 'inline-block'; // Or 'block'
            if (!tabEditSession) {
                tabEditSession = editorSessions.begin('tab', tab.id);
                initialName = titleInput.value.trim();
            }
            titleInput.select(); // Select text for easy replacement
            titleInput.focus(); // Focus the input
        });

        const saveOrCancelEdit = async (save, explicitlyConfirmed = false) => {
            const session = tabEditSession;
            if (!session) return;
            const newName = titleInput.value.trim();
            try {
                await editorSessions.complete(session, async () => {
                    if (save) {
                        const currentTab = await chrome.tabs.get(tab.id);
                        if (isPinned) {
                            if (explicitlyConfirmed || newName !== initialName) await savePinAlias(currentTab, tabElement, newName);
                        } else if (newName && newName !== currentTab.title) {
                            await Utils.setTabNameOverride(tab.id, tab.url, newName);
                        } else {
                            await Utils.removeTabNameOverride(tab.id);
                        }
                    }
                    const potentiallyUpdatedTab = await chrome.tabs.get(tab.id);
                    tab.title = potentiallyUpdatedTab.title;
                    tab.url = potentiallyUpdatedTab.url;
                    await updateDisplay();
                });
            } catch (error) {
                Logger.error("Error getting tab info or saving override:", error);
                alert(error.message);
            } finally {
                if (tabEditSession === session) tabEditSession = null;
            }
        };

        titleInput.addEventListener('blur', () => saveOrCancelEdit(true));
        titleInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault(); // Prevent potential form submission if wrapped
                await saveOrCancelEdit(true, true);
                titleInput.blur(); // Explicitly blur to hide input
            } else if (e.key === 'Escape') {
                await saveOrCancelEdit(false); // Cancel reverts input visually via updateDisplay
                titleInput.blur(); // Explicitly blur to hide input
            }
        });
    }

    // --- Initial Display ---
    await updateDisplay(); // Call initially to set the correct title/domain
    // Rendering can await bookmark/title metadata. Read the live state at the
    // end so an audio event during that work cannot leave a newly added row stale.
    let audioTab = tab;
    if (!isBookmarkOnly) {
        try { audioTab = await tabAudioEvents.read(() => chrome.tabs.get(tab.id)); } catch { audioTab = null; }
    }
    updateTabAudioIndicator(tabElement, audioTab, { live: !isBookmarkOnly });


    // Handle mousedown events (left-click to open, middle-click to close)
    // Middle-click never deletes a favorite that has no live tab.
    tabElement.addEventListener('auxclick', event => {
        if (event.button === MOUSE_BUTTON.MIDDLE) {
            event.preventDefault();
            if (isBookmarkOnly) return;
            closeTab(tabElement, tab, isPinned, isBookmarkOnly);
        }
    });
    // Activate after mouse-up so dragging an inactive tab does not rebuild its source.
    tabElement.addEventListener('click', async (event) => {
        if (event.button === MOUSE_BUTTON.MIDDLE) {
            event.preventDefault(); // Prevent default middle-click actions (like autoscroll)
            if (isBookmarkOnly) return;
            closeTab(tabElement, tab, isPinned, isBookmarkOnly);
        } else if (event.button === MOUSE_BUTTON.LEFT) {
            // Don't activate tab when clicking close button
            if (event.target === actionButton) return;

            if (!isBookmarkOnly && event.shiftKey) {
                event.preventDefault();
                selectTabRange(tab.id);
                return;
            }

            if (!isBookmarkOnly) {
                selectOnlyTab(tab.id);
            }

            // Remove active class from all tabs and favicons
            clearAllActiveStates();

            let chromeTab = null;
            try {
                chromeTab = await chrome.tabs.get(tab.id);
            } catch (e) {
                Logger.log("Tab likely closed during archival.", e, tab);
            }

            if (isBookmarkOnly || !chromeTab) {
                Logger.log('Opening bookmark:', tab);
                isOpeningBookmark = true; // Set flag
                try {
                    // Get URL from dataset if tab object doesn't have it (archived tab case)
                    const tabUrl = tab.url || tabElement.dataset.url;
                    if (!tabUrl) {
                        Logger.error("Cannot open bookmark: No URL found for archived tab.");
                        isOpeningBookmark = false;
                        return;
                    }

                    // A bookmark in this sidebar may only reuse a tab in this window.
                    const allTabs = await chrome.tabs.query({ windowId: currentWindow.id });
                    const clickedBookmarkId = tabElement.dataset.bookmarkId;
                    const bindings = await Utils.getPinnedTabStates();
                    const existingTab = clickedBookmarkId && allTabs.find(t =>
                        ownerOf(spaces, t.id)?.id === activeSpaceId &&
                        bindings[t.id]?.bookmarkId === clickedBookmarkId);
                    if (existingTab) {
                        await Utils.focusTab(existingTab.id);
                        await refreshActiveSpaceUI();
                        isOpeningBookmark = false;
                        return;
                    }

                    // Check if tab is in archive and restore it
                    const archivedTabs = await Utils.getArchivedTabs();
                    const archivedTab = !isPinned && archivedTabs.find(t => t.url === tabUrl);

                    let targetSpaceId = activeSpaceId;
                    let bookmarkTitle = tab.title || tabElement.querySelector('.tab-title-display')?.textContent || 'Bookmark';

                    if (archivedTab) {
                        Logger.log('Found archived tab, restoring from archive:', archivedTab);
                        targetSpaceId = archivedTab.spaceId || activeSpaceId;
                        bookmarkTitle = archivedTab.name || bookmarkTitle;

                        // Restore the archived tab
                        const restoredTab = await Utils.restoreArchivedTab(archivedTab);

                        if (restoredTab) {
                            // Pin the restored tab if it was originally pinned
                            if (isPinned) {
                                await chrome.tabs.update(restoredTab.id, { pinned: true });
                            }

                            // Tab is already active from restore, but ensure it's activated
                            chrome.tabs.update(restoredTab.id, { active: true });
                            activateTabInDOM(restoredTab.id);

                            // Update space data
                            const space = spaces.find(s => s.id === targetSpaceId);
                            if (space) {
                                space.lastTab = restoredTab.id;
                                // If this was a pinned tab, ensure it's in spaceBookmarks
                                if (isPinned) {
                                    // Remove any stale tabId references (in case old tabId was still in array)
                                    if (tab.id) {
                                        space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== tab.id);
                                    }
                                    // Add the new restored tabId
                                    if (!space.spaceBookmarks.includes(restoredTab.id)) {
                                        space.spaceBookmarks.push(restoredTab.id);
                                    }
                                }
                                saveSpaces();
                            }

                            // Ensure restored tab lands in correct Chrome position for this space.
                            await persistSpaceTabOrder(targetSpaceId, { source: 'arcify', movedTabId: restoredTab.id });

                            // Replace the element with the active tab element
                            if (isPinned) {
                                const pinnedUrl = tabElement.dataset.pinnedUrl || tabUrl;
                                const bookmarkId = tabElement.dataset.bookmarkId || null;
                                restoredTab.pinnedUrl = pinnedUrl;
                                restoredTab.bookmarkId = bookmarkId;
                                await Utils.setPinnedTabState(restoredTab.id, { pinnedUrl: pinnedUrl, bookmarkId: bookmarkId });
                            }
                            const updatedTabElement = await createTabElement(restoredTab, isPinned, false);
                            tabElement.replaceWith(updatedTabElement);
                            isOpeningBookmark = false;
                            return;
                        }
                    }

                    // Tab not found and not in archive, open as new bookmark
                    const space = spaces.find(s => s.id === targetSpaceId);
                    if (!space) {
                        Logger.error("Cannot open bookmark: Active space not found.");
                        isOpeningBookmark = false;
                        return;
                    }

                    // Get bookmark title from Chrome bookmarks if available
                    if (!tab.spaceName) {
                        // Try to find space name from targetSpaceId
                        const spaceWithTab = spaces.find(s => s.id === targetSpaceId);
                        if (spaceWithTab) {
                            tab.spaceName = spaceWithTab.name;
                        }
                    }

                    // Prepare bookmark data for opening
                    const bookmarkData = {
                        url: tabUrl,
                        title: bookmarkTitle,
                        spaceName: tab.spaceName || space.name,
                        pinnedUrl: tabElement.dataset.pinnedUrl || tabUrl,
                        bookmarkId: tabElement.dataset.bookmarkId || null
                    };

                    // Prepare context for BookmarkUtils
                    const context = {
                        spaces,
                        activeSpaceId: targetSpaceId,
                        currentWindow,
                        saveSpaces,
                        createTabElement,
                        activateTabInDOM,
                        Utils,
                        persistSpaceTabOrder,
                        getSpacePinNameDefaults
                    };

                    // Use shared bookmark opening logic
                    await BookmarkUtils.openBookmarkAsTab(bookmarkData, targetSpaceId, tabElement, context, isPinned);

                } catch (error) {
                    Logger.error("Error opening bookmark:", error);
                } finally {
                    isOpeningBookmark = false;
                    await pendingSpaceSaves;
                    await refreshActiveSpaceUI();
                    refreshCoordinator.schedule();
                }
            } else {
                // It's a regular tab, just activate it
                tabElement.classList.add('active');
                await Utils.focusTab(tab.id);
                // Store last active tab for the space
                const space = ownerOf(spaces, tab.id);
                if (space) {
                    space.lastTab = tab.id;
                    saveSpaces();
                }
            }
        }
    });

    // Set up drag handlers for all tabs (regular and bookmark-only)
    setupTabDragHandlers(tabElement);

    // --- Context Menu ---
    tabElement.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isBookmarkOnly && !selectedTabIds.has(tab.id)) {
            clearTabSelection();
        }
        const tabIds = isBookmarkOnly
            ? []
            : getContextTabIds(selectedTabIds, tab.id);
        const currentSpace = isBookmarkOnly
            ? spaces.find(space => space.id === tabElement.closest('.space')?.dataset.spaceId)
            : ownerOf(spaces, tab.id);
        const entries = tabIds.length > 1
            ? tabIds.map(tabId => ({
                tabId, bookmarkId: document.querySelector(`.tab[data-tab-id="${tabId}"]`)?.dataset.bookmarkId
            }))
            : [{ tabId: isBookmarkOnly ? null : tab.id, bookmarkId: tabElement.dataset.bookmarkId }];
        const createFolder = currentSpace && (!isBookmarkOnly || entries[0].bookmarkId)
            ? () => createFolderWithItems(currentSpace.id, entries)
            : null;
        const currentlyPinned = !isBookmarkOnly && currentSpace
            ? currentSpace.spaceBookmarks.includes(tab.id)
            : isPinned;
        const session = beginSidebarContextMenu(tabElement);
        try {
            const arcifyFolder = await getSidebarBookmarkRoot();
            const allBookmarkSpaceFolders = await chrome.bookmarks.getChildren(arcifyFolder.id);
            showTabContextMenu(
                session,
                e.pageX,
                e.pageY,
                tab,
                currentlyPinned,
                isBookmarkOnly,
                tabElement,
                closeTab,
                spaces,
                moveTabToSpace,
                setActiveSpace,
                allBookmarkSpaceFolders,
                createSpaceFromInactive,
                replaceBookmarkUrlWithCurrentUrl,
                moveFavoriteToSpace,
                tabIds.length > 1 ? {
                    tabIds,
                    addToFavorites: ids => favoriteRequest('pin', { tabIds: ids }),
                    setSpacePinned: setTabsSpacePinned,
                    moveToSpace: (ids, spaceId) => moveTabsToSpace(ids, spaceId, tab.id),
                    createInactiveSpace: createInactiveSpaceWithTabs,
                    archive: async ids => {
                        clearTabSelection();
                        for (const id of ids) await Utils.archiveTab(id);
                    },
                    close: closeSelectedTabs,
                    clearSelection: clearTabSelection
                } : null,
                createFolder
            );
        } catch (error) {
            session.close();
            Logger.warn('Could not open tab actions:', error);
        }
    });

    return tabElement;
}

async function createNewTab(callback = () => {}) {
    const spaceId = activeSpaceId;
    const tab = await chrome.tabs.create({ active: true, windowId: currentWindow.id });
    await spaceRequest('assign', { tabId: tab.id, spaceId });
    await adoptStoredSpaces(await spaceRequest('get'));
    if (typeof callback === 'function') callback();
    return tab;
}

async function createNewSpace() {
    Logger.log('Creating new space... Button clicked');
    isCreatingSpace = true;
    try {
        const spaceNameInput = document.getElementById('newSpaceName');
        const spaceColorSelect = document.getElementById('spaceColor');
        const spaceName = spaceNameInput.value.trim();
        const spaceColor = spaceColorSelect.value;

        if (!spaceName || spaces.some(space => space.name.toLowerCase() === spaceName.toLowerCase())) {
            const errorPopup = document.createElement('div');
            errorPopup.className = 'error-popup';
            errorPopup.textContent = 'A space with this name already exists';
            const inputContainer = document.getElementById('addSpaceInputContainer');
            inputContainer.appendChild(errorPopup);

            // Remove the error message after 3 seconds
            setTimeout(() => {
                errorPopup.remove();
            }, 3000);
            return;
        }


        // Create bookmark folder for new space, then anchor durable identity to it.
        const newSpaceFolder = await LocalStorage.getOrCreateSpaceFolder(spaceName);
        const registryEntry = await LocalStorage.getOrCreateSpaceRegistryEntry(newSpaceFolder.id, {
            name: spaceName,
            color: spaceColor,
        });

        const space = {
            id: registryEntry.spaceUuid,
            spaceUuid: registryEntry?.spaceUuid ?? Utils.generateUUID(),
            bookmarkFolderId: newSpaceFolder.id,
            uuid: registryEntry?.spaceUuid ?? Utils.generateUUID(),
            name: spaceName,
            color: spaceColor,
            spaceBookmarks: [],
            temporaryTabs: []
        };

        spaces.push(space);
        Logger.log('New space created:', { spaceId: space.id, spaceName: space.name, spaceColor: space.color });

        createSpaceElement(space);
        await updateSpaceSwitcher();
        await saveSpaces();
        await setActiveSpace(space.id);

        isCreatingSpace = false;
        // Reset the space creation UI and show space switcher
        const addSpaceBtn = document.getElementById('addSpaceBtn');
        const inputContainer = document.getElementById('addSpaceInputContainer');
        const spaceSwitcher = document.getElementById('spaceSwitcher');
        addSpaceBtn.classList.remove('active');
        inputContainer.classList.remove('visible');
        spaceSwitcher.style.opacity = '1';
        spaceSwitcher.style.visibility = 'visible';
    } catch (error) {
        showSpaceStoreError(error, 'bookmark_folder_unavailable');
        Logger.error('Error creating new space:', error);
    } finally {
        isCreatingSpace = false;
    }
}

async function handleTabCreated(tab) {
    if (!sidebarReady || isCreatingSpace || isOpeningBookmark || tab.pinned || tab.windowId !== currentWindow?.id) return;
    await pendingSpaceSaves;
    const next = await spaceRequest('get');
    await adoptStoredSpaces(next);
}


function handleTabUpdate(tabId, changeInfo, tab) {
    if (changeInfo.audible !== undefined || changeInfo.mutedInfo !== undefined) {
        tabAudioEvents.record(tab, currentWindow?.id);
        updateWindowTabAudio(document, tab, currentWindow?.id);
    }
    if (isAudioOnlyTabChange(changeInfo)) return;
    const faviconChanged = changeInfo.favIconUrl !== undefined;
    if (faviconChanged) invalidateSidebarFavicons(tab.url);
    if (isOpeningBookmark) {
        return;
    }
    chrome.windows.getCurrent({ populate: false }, async (currentWindow) => {
        if (tab.windowId !== currentWindow.id) return;
        Logger.log('Tab updated:', tabId, changeInfo, spaces);

        // Update tab element if it exists
        const tabElement = document.querySelector(`[data-tab-id="${tabId}"]`);
        if (tabElement) {
            // Update Favicon if URL changed
            if (changeInfo.url || faviconChanged) {
                const img = tabElement.querySelector('img');
                if (img) {
                    const favorite = tabElement.classList.contains('pinned-favicon');
                    const url = favorite ? tabElement.dataset.pinnedUrl || tab.url : tab.url;
                    setSidebarFavicon(img, url, favorite ? '96' : '16');
                }
            }

            const titleDisplay = tabElement.querySelector('.tab-title-display');
            const domainDisplay = tabElement.querySelector('.tab-domain-display');
            const titleInput = tabElement.querySelector('.tab-title-input'); // Get input element
            if (changeInfo.pinned !== undefined) {
                if (changeInfo.pinned) {
                    // Chrome-native-pinning a favorite must NOT delete its bookmark — the
                    // bookmark is the only durable record of the favorite. We only detach the
                    // runtime binding (remove the tab-id from the space arrays + pinned state)
                    // so the favorite persists as an unrealized bookmark and re-binds on unpin.

                    // Remove tab from all spaces data when it becomes pinned
                    spaces.forEach(space => {
                        space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== tabId);
                        space.temporaryTabs = space.temporaryTabs.filter(id => id !== tabId);
                    });
                    await Utils.removePinnedTabState(tabId);
                    saveSpaces();
                    editorSessions.dispose('tab', tabId);
                    const spaceRow = document.querySelector(`.tab[data-tab-id="${tabId}"]`);
                    if (spaceRow) {
                        disposeEditorsInElement(spaceRow);
                        spaceRow.remove();
                    }
                } else {
                    try {
                        await moveTabToSpace(tabId, activeSpaceId, false /* pinned */);
                    } catch (error) {
                        Logger.warn('Could not restore unpinned tab to its space:', error);
                        refreshCoordinator.invalidateSpaces();
                    }
                }
                // Update pinned favicons for both pinning and unpinning
                updatePinnedFavicons();
            } else if (titleDisplay && domainDisplay && titleInput) { // Check if elements exist
                // Don't update if the input field is currently focused
                if (document.activeElement !== titleInput) {
                    const overrides = await Utils.getTabNameOverrides();
                    const pinnedUrl = tabElement.dataset.pinnedUrl || (await Utils.getPinnedTabState(tabId))?.pinnedUrl;
                    renderLiveTabLabel(tabElement, tab, overrides[tabId], pinnedUrl);
                }
            }
            let faviconElement = tabElement.querySelector('.tab-favicon');
            if (!faviconElement) {
                // fallback to img element
                faviconElement = tabElement.querySelector('img');
            }
            if (changeInfo.url && faviconElement) {
                // Do NOT auto-overwrite the pinned bookmark URL on navigation.
                // Instead, make favicon look actionable and show the Arc-like label only on favicon hover.
                tabElement.dataset.url = tab.url;
                if (tabElement.closest('[data-tab-type="pinned"]')) {
                    const pinnedUrl = tabElement.dataset.pinnedUrl || (await Utils.getPinnedTabState(tabId))?.pinnedUrl;
                    const shouldEnableBack = isAwayFromPin(tab.url, pinnedUrl);
                    faviconElement.classList.toggle('pinned-back', shouldEnableBack);
                    faviconElement.title = shouldEnableBack ? 'Back to Pinned URL' : '';
                    const slash = tabElement.querySelector('.tab-url-changed-slash');
                    if (slash) slash.classList.toggle('visible', shouldEnableBack);
                }
            } else if (!faviconElement) {
                Logger.log('No favicon element found', faviconElement, tabElement);
            }
            // Update active state when tab's active state changes
            if (changeInfo.active !== undefined && changeInfo.active) {
                activateTabInDOM(tabId);
            }
            if (changeInfo.status == 'complete' || changeInfo.status == 'loading') {
                // Scroll to the newly created tab
                scrollToTab(tabId, 100);
            }
        }
    });
}

const removingTabIds = new Set();
async function handleTabRemove(tabId) {
    removeCleanCandidate(tabId);
    tabAudioEvents.forget(tabId);
    if (removingTabIds.has(tabId)) return;
    removingTabIds.add(tabId);
    const tabElement = document.querySelector(`[data-tab-id="${tabId}"]`);
    // Capture the durable row before an authoritative storage refresh removes
    // the tab's live membership. Native removal has already happened; only the
    // sidebar projection waits for motion.
    const persistentRow = Boolean(tabElement?.dataset.bookmarkId ||
        ownerOf(spaces, tabId)?.spaceBookmarks.includes(tabId));
    pendingMutationCount++;
    try {
        const reconcile = () => reconcileRemovedTab(tabId, tabElement, persistentRow);
        await withRemovedTabMotion(tabElement?.classList.contains('tab') ? tabElement : null,
            reconcile, { collapse: !persistentRow });
    } catch (error) {
        Logger.warn('Could not reconcile closed tab:', error);
        refreshCoordinator.invalidateSpaces();
    } finally {
        removingTabIds.delete(tabId);
        pendingMutationCount--;
        refreshCoordinator.schedule();
    }
}

async function reconcileRemovedTab(tabId, tabElement, isPinned) {
    Logger.log('Tab removed:', tabId);
    editorSessions.dispose('tab', tabId);
    selectedTabIds.delete(tabId);
    if (selectionAnchorTabId === tabId) selectionAnchorTabId = null;
    syncTabSelectionUI();
    await Utils.removePinnedTabState(tabId);
    if (tabElement?.classList.contains('pinned-favicon')) {
        await updatePinnedFavicons();
        return;
    }
    if (!tabElement) return;
    Logger.log("tabElement", tabElement);

    if (isPinned && tabElement.dataset.bookmarkId) {
        try {
            const [bookmark] = await chrome.bookmarks.get(tabElement.dataset.bookmarkId);
            if (bookmark?.url) {
                const row = await createTabElement({ id: null, title: bookmark.title,
                    url: bookmark.url, pinnedUrl: bookmark.url, bookmarkId: bookmark.id }, true, true);
                tabElement.replaceWith(row);
            } else tabElement.remove();
        } catch { tabElement.remove(); }
    } else tabElement.remove();

    // Remove tab from spaces
    spaces.forEach(space => {
        space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== tabId);
        space.temporaryTabs = space.temporaryTabs.filter(id => id !== tabId);
    });

    saveSpaces();

    // Update pinned favicons to show/hide placeholder when last pinned tab is removed
    updatePinnedFavicons();
}

// Prevent overlapping membership changes for the same tab.
const processingTabMoves = new Set();

function handleTabActivated(activeInfo) {
    if (isCreatingSpace) {
        Logger.log('Skipping tab creation handler - space is being created');
        return;
    }
    chrome.windows.getCurrent({ populate: false }, async (currentWindow) => {
        if (activeInfo.windowId !== currentWindow.id) {
            Logger.log('New tab is in a different window, ignoring...');
            return;
        }

        Logger.log('Tab activated:', activeInfo);
        if (isDraggingTab) tabPointerDrag.cancel();
        activeChromeTabId = activeInfo.tabId;
        selectOnlyTab(activeInfo.tabId);
        // Find which space contains this tab
        const spaceWithTab = spaces.find(space =>
            space.spaceBookmarks.includes(activeInfo.tabId) ||
            space.temporaryTabs.includes(activeInfo.tabId)
        );
        Logger.log("found space", spaceWithTab);

        if (spaceWithTab) {
            spaceWithTab.lastTab = activeInfo.tabId;
            saveSpaces();
            Logger.log("lasttab space", spaces);
        }

        if (spaceWithTab && spaceWithTab.id !== activeSpaceId) {
            // Switch to the space containing the tab
            spaceSwipe?.cancel();
            closeCleanPreview();
            activeSpaceId = spaceWithTab.id;
            await activateSpaceInDOM(spaceWithTab.id, spaces, updateSpaceSwitcher);
            await refreshActiveSpaceUI();
            activateTabInDOM(activeInfo.tabId);
        } else {
            // Activate only the tab in the current space
            activateTabInDOM(activeInfo.tabId);
        }

        // Scroll to the activated tab's location
        scrollToTab(activeInfo.tabId, 0);
    });
}

function countBookmarks(node) {
    if (node.url) return 1;
    return (node.children || []).reduce((sum, child) => sum + countBookmarks(child), 0);
}

async function deleteSpace(spaceId) {
    Logger.log('Deleting space:', spaceId);
    const space = spaces.find(s => s.id === spaceId);
    if (space) {
        const folderToDelete = await getSpaceBookmarkFolder(space);
        // Another sidebar or Settings can change the default while confirmation is open.
        const saved = await chrome.storage.local.get(['spaces', 'defaultSpaceName']);
        const current = saved.spaces?.find(item => item.id === spaceId);
        if (!current || current.bookmarkFolderId !== folderToDelete.id) {
            throw new Error('The space bookmark folder has changed. Reopen its menu to try again.');
        }
        if (resolveDefaultSpace(saved.spaces, saved.defaultSpaceName || 'Home')?.id === spaceId) {
            throw new Error('The default space cannot be deleted.');
        }
        editorSessions.dispose('folder-pending', spaceId);
        editorSessions.dispose('space', spaceId);
        await chrome.bookmarks.removeTree(folderToDelete.id);
        await LocalStorage.removeSpaceRegistryEntry(folderToDelete.id);
        // Close live tabs owned by the deleted space.
        const ownedTabs = (await chrome.tabs.query({})).filter(t => ownerOf(spaces, t.id)?.id === spaceId);

        // Remove space from array
        spaces = spaces.filter(s => s.id !== spaceId);
        await saveSpaces();
        if (ownedTabs.length) await chrome.tabs.remove(ownedTabs.map(t => t.id));

        // Remove space element from DOM
        const spaceElement = document.querySelector(`[data-space-id="${spaceId}"]`);
        if (spaceElement) {
            disposeEditorsInElement(spaceElement);
            spaceElement.remove();
        }

        // If this was the active space, switch to another space
        if (activeSpaceId === spaceId && spaces.length > 0) {
            await setActiveSpace(spaces[0].id);
        }

        // Save changes
        saveSpaces();
        await updateSpaceSwitcher();
    }
}

////////////////////////////////////////////////////////////////
// -- Helper Functions
////////////////////////////////////////////////////////////////

/**
 * Scrolls to make a tab visible in the sidebar
 * @param {number} tabId - The ID of the tab to scroll to
 * @param {number} timeout - Timeout in milliseconds to wait before scrolling
 */
function scrollToTab(tabId, timeout = 0) {
    setTimeout(() => {
        const tabElement = document.querySelector(`[data-tab-id="${tabId}"]`);
        if (tabElement) {
            const spaceElement = tabElement.closest('[data-space-id]');
            if (spaceElement) {
                const spaceContent = spaceElement.querySelector('.space-content');
                if (spaceContent) {
                    const tabRect = tabElement.getBoundingClientRect();
                    const spaceContentRect = spaceContent.getBoundingClientRect();

                    // Check if the tab is visible in the space content
                    const isTabVisible = tabRect.top >= spaceContentRect.top && tabRect.bottom <= spaceContentRect.bottom;

                    if (!isTabVisible) {
                        Logger.log('[ScrollDebug] Scrolling to show tab');
                        // Scroll to make the tab visible
                        const scrollTop = spaceContent.scrollTop + (tabRect.top - spaceContentRect.top);
                        spaceContent.scrollTop = scrollTop;
                    } else {
                        Logger.log('[ScrollDebug] Tab is already visible, no scroll needed');
                    }
                } else {
                    Logger.log('[ScrollDebug] Space content not found, no scroll needed');
                }
            } else {
                Logger.log('[ScrollDebug] Space not found, no scroll needed');
            }
        } else {
            Logger.log('[ScrollDebug] Tab not found, no scroll needed');
        }
    }, timeout);
}

async function moveTabToSpace(tabId, spaceId, pinned = false, openerTabId = null) {
    if (!spaces.some(s => s.id === spaceId)) return;
    processingTabMoves.add(tabId);
    try {
    // Native pin teardown can emit an unpin update after the tab has closed.
    // Validate before changing membership or removing its old projection.
    let chromeTab;
    try {
        chromeTab = await chrome.tabs.get(tabId);
    } catch (error) {
        if (/No tab with id:/i.test(error?.message || String(error))) return;
        throw error;
    }
    // The destination may have disappeared while the native lookup was pending.
    const space = spaces.find(s => s.id === spaceId);
    if (!space) {
        Logger.warn(`Space with ID ${spaceId} not found.`);
        return;
    }
    // Remove tab from its original space data first
    const sourceSpace = spaces.find(s =>
        s.temporaryTabs.includes(tabId) || s.spaceBookmarks.includes(tabId)
    );
    if (sourceSpace && sourceSpace.id !== spaceId) {
        sourceSpace.temporaryTabs = sourceSpace.temporaryTabs.filter(id => id !== tabId);
        sourceSpace.spaceBookmarks = sourceSpace.spaceBookmarks.filter(id => id !== tabId);
        sourceSpace.lastTab = null;
    }

    // 3. Update local space data
    // Remove tab from both arrays just in case
    space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== tabId);
    space.temporaryTabs = space.temporaryTabs.filter(id => id !== tabId);
    space.lastTab = tabId;

    if (pinned) {
        space.spaceBookmarks.push(tabId);
    } else {
        const openerIndex = space.temporaryTabs.indexOf(openerTabId);
        if (openerIndex >= 0) space.temporaryTabs.splice(openerIndex + 1, 0, tabId);
        else space.temporaryTabs.push(tabId);
    }

    // 4. Update the UI (remove tab element from old section, create it in new section)
    // Remove any existing DOM element for this tab
    const oldTabElement = document.querySelector(`[data-tab-id="${tabId}"]`);
    oldTabElement?.remove();

    // Add a fresh tab element if needed
    const spaceElement = document.querySelector(`[data-space-id="${spaceId}"]`);
    if (spaceElement) {
        const containerSelector = pinned ? '[data-tab-type="pinned"]' : '[data-tab-type="temporary"]';
        const container = spaceElement.querySelector(containerSelector);

        if (chromeTab.windowId !== currentWindow.id) { await saveSpaces(); return; }
        const tabElement = await createTabElement(chromeTab, pinned);
        if (container.children.length > 1) {
            if (openerTabId) {
                let tabs = container.querySelectorAll(`.tab`);
                const openerTabIndex = Array.from(tabs).findIndex(tab => tab.dataset.tabId == openerTabId);
                if (openerTabIndex + 1 < tabs.length) {
                    const tabToInsertBefore = tabs[openerTabIndex + 1];
                    container.insertBefore(tabElement, tabToInsertBefore);
                } else {
                    container.appendChild(tabElement);
                }
            } else {
                if (pinned) {
                    // Add to the bottom after all existing elements
                    container.appendChild(tabElement);
                } else {
                    // Render temporary tabs in extension order
                    const ownedTabs = await getOwnedTabs(spaceId);
                    const currentTabIndex = ownedTabs.findIndex(t => t.id === tabId);

                    if (currentTabIndex !== -1 && ownedTabs.length > 1) {
                        // First, add the new tab element to the container so it can be found in the filter
                        container.appendChild(tabElement);

                        // Filter to only include tabs in the temporary container (including the new one)
                        const tabsInContainer = ownedTabs.filter(t => {
                            return container.querySelector(`[data-tab-id="${t.id}"]:not(.favorite-fallback)`);
                        });

                        // Apply invert order if enabled
                        const invertTabOrder = await Utils.getInvertTabOrder();
                        if (invertTabOrder) {
                            tabsInContainer.reverse();
                        }

                        // Re-append all tabs in correct order (including the new one)
                        tabsInContainer.forEach(t => {
                            const el = container.querySelector(`[data-tab-id="${t.id}"]`);
                            if (el) {
                                container.appendChild(el);
                            }
                        });
                    } else {
                        // Fallback: use simple insert logic
                        const invertTabOrder = await Utils.getInvertTabOrder();
                        if (invertTabOrder) {
                            container.insertBefore(tabElement, container.firstChild);
                        } else {
                            container.appendChild(tabElement);
                        }
                    }
                }
            }
        } else {
            container.appendChild(tabElement);
        }
    }

    // 5. Save the updated spaces to storage
    saveSpaces();
    } finally {
        // Always release the processing lock, even on the early `space not found`
        // return or any throw above — otherwise future moves for this tab are ignored.
        processingTabMoves.delete(tabId);
    }
}

// The bookmark is the durable favorite, so move it before reassigning any live tab that uses it.
async function moveFavoriteToSpace(tab, tabElement, spaceId) {
    const target = spaces.find(s => s.id === spaceId);
    const source = tab.id
        ? ownerOf(spaces, tab.id)
        : spaces.find(s => s.id === tabElement.closest('.space')?.dataset.spaceId);
    if (!target || !source || source.id === target.id) return;
    const binding = tab.id ? await Utils.getPinnedTabState(tab.id) : null;
    const bookmark = await getSpaceBookmarkById(source, tabElement.dataset.bookmarkId || binding?.bookmarkId);
    if (!bookmark) throw new Error('The favorite binding is no longer valid for this space.');
    const targetFolder = await getSpaceBookmarkFolder(target);
    const boundTabIds = (await getTabsBoundToBookmark(source, bookmark.id)).filter(id => id !== tab.id);
    await chrome.bookmarks.move(bookmark.id, { parentId: targetFolder.id });
    if (tab.id) {
        await moveTabToSpace(tab.id, target.id, true);
    } else {
        disposeEditorsInElement(tabElement);
        tabElement.remove();
    }
    for (const id of boundTabIds) await moveTabToSpace(id, target.id, true);
}

// A favorite can be open in several windows, and each of those tabs follows its bookmark.
async function getTabsBoundToBookmark(space, bookmarkId) {
    const bindings = await Utils.getPinnedTabStates();
    const liveTabIds = new Set((await chrome.tabs.query({})).map(t => t.id));
    return space.spaceBookmarks.filter(id => liveTabIds.has(id) && String(bindings[id]?.bookmarkId) === String(bookmarkId));
}

// Reusable function to set up folder context menu
function setupFolderContextMenu(folderElement, space) {
    folderElement.addEventListener('contextmenu', async (e) => {
        if (e.target.closest('.tab')) return;
        e.preventDefault();
        e.stopPropagation();

        const session = beginSidebarContextMenu(folderElement.querySelector('.folder-header') || folderElement);
        try {
            const contextMenu = document.createElement('div');
            contextMenu.classList.add('context-menu', 'folder-context-menu');
            contextMenu.setAttribute('role', 'menu');
            contextMenu.setAttribute('aria-label', 'Folder actions');
            contextMenu.style.position = 'fixed';
            contextMenu.style.left = `${e.clientX}px`;
            contextMenu.style.top = `${e.clientY}px`;

            const spaceElement = folderElement.closest('.space');
            const spaceFolder = await getSpaceBookmarkFolder(space);
            const folderId = folderElement.dataset.bookmarkId;
            if (folderId && await canCreateFolder(spaceFolder.id, folderId)) {
                const newFolderOption = document.createElement('button');
                newFolderOption.type = 'button';
                newFolderOption.classList.add('context-menu-item');
                newFolderOption.setAttribute('role', 'menuitem');
                newFolderOption.textContent = 'New Folder';
                newFolderOption.addEventListener('click', async () => {
                    session.close();
                    await createNewFolder(spaceElement, folderElement);
                });
                contextMenu.appendChild(newFolderOption);
            }

            const renameOption = document.createElement('button');
            renameOption.type = 'button';
            renameOption.classList.add('context-menu-item');
            renameOption.setAttribute('role', 'menuitem');
            renameOption.textContent = 'Rename';
            renameOption.addEventListener('click', () => {
                session.close();
                folderNameEditors.get(folderElement)?.();
            });
            contextMenu.appendChild(renameOption);

            const parentId = String(folderElement.parentElement.closest('.folder')?.dataset.bookmarkId || spaceFolder.id);
            // Chrome reads a same-parent move index before removing the node, so moving to
            // index + 1 is a no-op; swap by moving the later sibling to the earlier index.
            const findSwap = (siblings, offset) => {
                const folderIndex = siblings.findIndex(sibling => String(sibling.id) === String(folderId));
                const neighborIndex = folderIndex + offset;
                if (folderIndex === -1 || neighborIndex < 0 || neighborIndex >= siblings.length) return null;
                return { id: siblings[Math.max(folderIndex, neighborIndex)].id, index: Math.min(folderIndex, neighborIndex) };
            };
            const siblings = await chrome.bookmarks.getChildren(parentId);
            for (const [label, offset] of [['Move Up', -1], ['Move Down', 1]]) {
                if (!findSwap(siblings, offset)) continue;

                const moveOption = document.createElement('button');
                moveOption.type = 'button';
                moveOption.setAttribute('role', 'menuitem');
                moveOption.classList.add('context-menu-item');
                moveOption.textContent = label;
                moveOption.addEventListener('click', async () => {
                    session.close();
                    try {
                        const swap = findSwap(await chrome.bookmarks.getChildren(parentId), offset);
                        if (swap) await chrome.bookmarks.move(swap.id, { parentId, index: swap.index });
                    } catch (error) {
                        Logger.error('Error moving folder:', error);
                    }
                });
                contextMenu.appendChild(moveOption);
            }

            const deleteOption = document.createElement('button');
            deleteOption.type = 'button';
            deleteOption.classList.add('context-menu-item');
            deleteOption.setAttribute('role', 'menuitem');
            deleteOption.textContent = 'Delete Folder';
            deleteOption.addEventListener('click', async () => {
                session.close();
                if (confirm('Are you sure you want to delete this folder and all its contents?')) {
                    if (folderId) await chrome.bookmarks.removeTree(folderId);
                    editorSessions.dispose('folder', folderId);
                    const parentFolder = folderElement.parentElement.closest('.folder');
                    disposeEditorsInElement(folderElement);
                    folderElement.remove();
                    if (parentFolder) updateFolderPlaceholder(parentFolder);
                    updatePinnedSectionPlaceholders();
                }
            });

            contextMenu.appendChild(deleteOption);
            if (!session.open(contextMenu)) return;

            const menuRect = contextMenu.getBoundingClientRect();
            const gutter = 8;
            contextMenu.style.left = `${Math.max(gutter, Math.min(e.clientX, window.innerWidth - menuRect.width - gutter))}px`;
            contextMenu.style.top = `${Math.max(gutter, Math.min(e.clientY, window.innerHeight - menuRect.height - gutter))}px`;
            contextMenu.querySelector('.context-menu-item')?.focus();
        } catch (error) {
            session.close();
            Logger.warn('Could not open folder actions:', error);
        }
    });
}
