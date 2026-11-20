import { isTrustedExtensionMessage } from './message-security.js';
import { DEFAULT_SPACE_COLOR, LIGHT_SPACE_COLOR, spacePaletteColor } from './space-colors.js';
import { spaceRequest } from './space-client.js';
import { setSidebarFavicon, wrapSidebarFavicon } from './sidebar-favicon.js';
/**
 * DOMManager - Sidebar DOM manipulation and UI component management
 * 
 * Purpose: Handles dynamic DOM creation, updates, and event handling for sidebar interface
 * Key Functions: Space/tab DOM rendering, context menus, input dialogs, drag-and-drop visual feedback
 * Architecture: Collection of utility functions for DOM manipulation and UI state management
 * 
 * Critical Notes:
 * - Separates DOM manipulation logic from business logic in sidebar.js
 * - Handles complex UI interactions like drag-and-drop visual feedback
 * - Manages context menus and modal dialogs for user interactions
 * - Provides reusable UI components for consistent user experience
 */

import { Utils } from './utils.js';
import { favoriteRequest } from './native-favorites.js';
import { RESTORE_ICON } from './icons.js';
import { Logger } from './logger.js';

// DOM Elements
const spacesList = document.getElementById('spacesList');
const spaceSwitcher = document.getElementById('spaceSwitcher');
const addSpaceBtn = document.getElementById('addSpaceBtn');
const spaceTemplate = document.getElementById('spaceTemplate');

export function setupDOMElements(createNewSpace) {
    // Mouse-wheel scroll support for the space chip strip.
    //
    // Why this handler exists: the strip has `overflow-x: auto`, so trackpad
    // horizontal swipes already scroll it natively (with momentum). But a
    // standard vertical mouse wheel has no horizontal axis, so users with a
    // mouse couldn't scroll the chips at all. This handler translates vertical
    // wheel ticks into horizontal scrollLeft to fix that.
    //
    // Native horizontal scrolling retains trackpad momentum. Stop bubbling in
    // both directions so chip scrolling never turns into a Space switch.
    spaceSwitcher.addEventListener('wheel', (event) => {
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
            event.stopPropagation();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        spaceSwitcher.scrollLeft += event.deltaY;
    }, { passive: false });

    // Add event listeners for buttons
    addSpaceBtn.addEventListener('click', () => {
        const inputContainer = document.getElementById('addSpaceInputContainer');
        const spaceNameInput = document.getElementById('newSpaceName');
        const isInputVisible = inputContainer.classList.contains('visible');

        // Toggle visibility classes
        inputContainer.classList.toggle('visible');
        addSpaceBtn.classList.toggle('active');

        // Toggle space switcher visibility
        if (isInputVisible) {
            spaceSwitcher.style.opacity = '1';
            spaceSwitcher.style.visibility = 'visible';
        } else {
            spaceNameInput.value = '';
            document.getElementById('createSpaceBtn').disabled = true;
            select.value = DEFAULT_SPACE_COLOR;
            select.dispatchEvent(new Event('change'));
            spaceSwitcher.style.opacity = '0';
            spaceSwitcher.style.visibility = 'hidden';
        }
    });

    document.getElementById('createSpaceBtn').addEventListener('click', createNewSpace);

    const select = document.getElementById('spaceColor');
    setupSpaceColorPicker(select, document.getElementById('createSpaceColorSwatch'));

    // Add input validation for new space name
    document.getElementById('newSpaceName').addEventListener('input', (e) => {
        const createSpaceBtn = document.getElementById('createSpaceBtn');
        createSpaceBtn.disabled = !e.target.value.trim();
    });
}

export function setupSpaceColorPicker(select, palette) {
    const swatches = Array.from(select.options, option => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'color-swatch';
        button.dataset.color = option.value;
        button.title = option.text;
        button.setAttribute('aria-label', option.text);
        if (option.value === DEFAULT_SPACE_COLOR || option.value === LIGHT_SPACE_COLOR) {
            button.classList.add('preset-swatch');
            const chip = document.createElement('span');
            chip.className = 'prismarc-color-chip';
            chip.setAttribute('aria-hidden', 'true');
            button.append(chip, option.text);
        }
        button.addEventListener('click', () => {
            if (select.value === option.value) return;
            select.value = option.value;
            select.dispatchEvent(new Event('change'));
        });
        return button;
    });
    const updateSelection = () => {
        for (const swatch of swatches) {
            const selected = swatch.dataset.color === select.value;
            swatch.classList.toggle('selected', selected);
            swatch.setAttribute('aria-pressed', String(selected));
        }
    };
    palette.append(...swatches);
    select.addEventListener('change', updateSelection);
    updateSelection();
}

export function applySpaceColor(color = DEFAULT_SPACE_COLOR, { refresh = false } = {}) {
    const sidebar = document.getElementById('sidebar-container');
    if (sidebar.dataset.spaceColor === color && !refresh) return;
    sidebar.classList.add('updating-space-color');
    sidebar.dataset.spaceColor = color;
    sidebar.dataset.spaceTheme = color;
    sidebar.style.setProperty('--space-base-color', spacePaletteColor(color));
    sidebar.style.setProperty('--space-base-color-dark', spacePaletteColor(color, true));
    // Commit the new palette together, then restore transitions for hover and selection.
    void sidebar.offsetWidth;
    sidebar.classList.remove('updating-space-color');
}

export function showSpaceNameInput() {
    const addSpaceBtn = document.getElementById('addSpaceBtn');
    const addSpaceInputContainer = document.getElementById('addSpaceInputContainer');

    addSpaceBtn.classList.toggle('active');
    addSpaceInputContainer.classList.toggle('visible');
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

export function activateTabInDOM(tabId) {
    // Remove active class from all tabs and pinned favicons
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.pinned-favicon').forEach(f => f.classList.remove('active'));

    // If there's a tab element with this ID, mark it active
    const targetTab = document.querySelector(`[data-tab-id="${tabId}"]`);
    if (targetTab) {
        targetTab.classList.add('active');
    }
}

export function activateSpaceInDOM(spaceId, spaces, updateSpaceSwitcher) {
    // Show/hide space containers
    document.querySelectorAll('.space').forEach(s => {
        const isActive = s.dataset.spaceId === String(spaceId);
        s.classList.toggle('active', isActive);
        s.style.display = isActive ? 'flex' : 'none';
    });

    const space = spaces.find(s => s.id === spaceId);
    if (space) applySpaceColor(space.color);

    // Update space switcher
    updateSpaceSwitcher();
}

export function showTabContextMenu(session, x, y, tab, isPinned, isBookmarkOnly, tabElement, closeTab, spaces, moveTabToSpace, setActiveSpace, allBookmarkSpaceFolders, createSpaceFromInactive, onReplaceBookmarkUrlWithCurrent = null, moveFavoriteToSpace = null, bulkActions = null, createFolder = null) {
    const contextMenu = document.createElement('div');
    contextMenu.id = 'tab-context-menu';
    contextMenu.className = 'context-menu'; // Reuse general context menu styling
    contextMenu.style.position = 'fixed';
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
    contextMenu.setAttribute('role', 'menu');
    contextMenu.setAttribute('aria-label', bulkActions ? `${bulkActions.tabIds.length} selected tabs` : 'Tab actions');
    contextMenu.tabIndex = -1;

    const selectedCount = bulkActions?.tabIds?.length || 1;
    const plural = selectedCount > 1;
    const finishBulkAction = () => bulkActions?.clearSelection?.();

    // --- Menu Items ---

    // Only show these options for actual tabs that are part of a space
    if (!isBookmarkOnly) {
        const addToFavoritesOption = document.createElement('div');
        addToFavoritesOption.className = 'context-menu-item';
        addToFavoritesOption.textContent = plural ? `Add ${selectedCount} Tabs to Favorites` : 'Add to Favorites';
        addToFavoritesOption.setAttribute('role', 'menuitem');
        addToFavoritesOption.addEventListener('click', async () => {
            session.close();
            try {
                if (bulkActions) await bulkActions.addToFavorites(bulkActions.tabIds);
                else await favoriteRequest('pin', { tabIds: [tab.id] });
                finishBulkAction();
            } catch (error) {
                alert(error.message);
            }
        });
        contextMenu.appendChild(addToFavoritesOption);

        const pinInSpaceOption = document.createElement('div');
        pinInSpaceOption.className = 'context-menu-item';
        pinInSpaceOption.textContent = plural
            ? `${isPinned ? 'Unpin' : 'Pin'} ${selectedCount} Tabs`
            : isPinned ? 'Unpin Tab' : 'Pin Tab';
        pinInSpaceOption.setAttribute('role', 'menuitem');
        pinInSpaceOption.addEventListener('click', async () => {
            session.close();
            if (bulkActions) await bulkActions.setSpacePinned(bulkActions.tabIds, !isPinned);
            else chrome.runtime.sendMessage({ command: 'toggleSpacePin', tabId: tab.id });
            finishBulkAction();
        });
        contextMenu.appendChild(pinInSpaceOption);

        // Arc-like: allow updating the underlying space bookmark URL to the current tab URL.
        if (!bulkActions && isPinned && typeof onReplaceBookmarkUrlWithCurrent === 'function') {
            const replaceBookmarkUrlOption = document.createElement('div');
            replaceBookmarkUrlOption.className = 'context-menu-item';
            replaceBookmarkUrlOption.textContent = 'Replace Bookmark URL with Current URL';
            replaceBookmarkUrlOption.addEventListener('click', async () => {
                session.close();
                try {
                    await onReplaceBookmarkUrlWithCurrent(tab, tabElement);
                } catch (e) {
                    Logger.warn('[ContextMenu] Failed to replace bookmark URL with current URL:', e);
                }
            });
            contextMenu.appendChild(replaceBookmarkUrlOption);
        }

    }

    if (createFolder) {
        const newFolderOption = document.createElement('div');
        newFolderOption.className = 'context-menu-item';
        newFolderOption.setAttribute('role', 'menuitem');
        newFolderOption.textContent = plural ? `New Folder with ${selectedCount} Items` : 'Add to New Folder';
        newFolderOption.addEventListener('click', async () => {
            session.close();
            try {
                await createFolder();
            } catch (error) {
                alert(error.message);
            }
        });
        contextMenu.appendChild(newFolderOption);
    }

    if (!isBookmarkOnly || createFolder) {
        const separator = document.createElement('div');
        separator.className = 'context-menu-separator';
        contextMenu.appendChild(separator);
    }

    // Favorites must carry their saved bookmark so moving them does not silently unpin them.
    if (!isBookmarkOnly || typeof moveFavoriteToSpace === 'function') {
        const moveToSpaceItem = document.createElement('div');
        moveToSpaceItem.className = 'context-menu-item with-submenu';
        moveToSpaceItem.textContent = plural ? `Move ${selectedCount} Tabs to Space` : 'Move to Space';
        moveToSpaceItem.setAttribute('role', 'menuitem');

        const submenu = document.createElement('div');
        submenu.className = 'context-menu submenu';

        // Add active spaces
        const currentSpace = isBookmarkOnly
            ? spaces.find(s => s.id === tabElement.closest('.space')?.dataset.spaceId)
            : spaces.find(s => s.temporaryTabs.includes(tab.id) || s.spaceBookmarks.includes(tab.id));
        const otherActiveSpaces = spaces.filter(s => s.id !== currentSpace?.id);
        otherActiveSpaces.forEach(space => {
            const submenuItem = document.createElement('div');
            submenuItem.className = 'context-menu-item';
            submenuItem.textContent = space.name;
            submenuItem.addEventListener('click', async (e) => {
                e.stopPropagation();
                session.close();

                if (bulkActions) {
                    await bulkActions.moveToSpace(bulkActions.tabIds, space.id);
                } else {
                    if (isPinned && typeof moveFavoriteToSpace === 'function') {
                        try {
                            await moveFavoriteToSpace(tab, tabElement, space.id);
                        } catch (error) {
                            Logger.warn('[ContextMenu] Failed to move favorite to space:', error);
                            return;
                        }
                    } else {
                        await moveTabToSpace(tab.id, space.id, false);
                    }
                    // Set the space as active, but prevent it from auto-activating a different tab
                    await setActiveSpace(space.id, false);
                    // Explicitly activate the tab that was just moved
                    if (!isBookmarkOnly) await Utils.focusTab(tab.id);
                }
            });
            submenu.appendChild(submenuItem);
        });

        // Add inactive spaces
        const activeSpaceNames = new Set(spaces.map(s => s.name));
        // Creating an inactive space needs a live tab, which unloaded favorites do not have.
        const inactiveSpaceFolders = isBookmarkOnly ? [] : allBookmarkSpaceFolders.filter(f => !f.url && !activeSpaceNames.has(f.title));

        if (otherActiveSpaces.length > 0 && inactiveSpaceFolders.length > 0) {
            const separator = document.createElement('div');
            separator.className = 'context-menu-separator';
            submenu.appendChild(separator);
        }

        inactiveSpaceFolders.forEach(folder => {
            const submenuItem = document.createElement('div');
            submenuItem.className = 'context-menu-item';
            submenuItem.textContent = folder.title;
            submenuItem.addEventListener('click', async (e) => {
                e.stopPropagation();
                session.close();
                if (bulkActions) await bulkActions.createInactiveSpace(folder.title, bulkActions.tabIds);
                else await createSpaceFromInactive(folder.title, tab);
            });
            submenu.appendChild(submenuItem);
        });

        // Only add the "Move to" menu if there's somewhere to move to
        if (submenu.hasChildNodes()) {
            moveToSpaceItem.appendChild(submenu);
            contextMenu.appendChild(moveToSpaceItem);

            // Adjust submenu position when it becomes visible
            moveToSpaceItem.addEventListener('mouseenter', () => {
                // Wait for next frame to ensure submenu is rendered
                requestAnimationFrame(() => {
                    const submenuRect = submenu.getBoundingClientRect();
                    const parentRect = moveToSpaceItem.getBoundingClientRect();
                    const viewportWidth = window.innerWidth;
                    const viewportHeight = window.innerHeight;

                    // Reset any previous adjustments
                    submenu.style.left = '';
                    submenu.style.right = '';
                    submenu.style.top = '';
                    submenu.style.bottom = '';

                    // Check if submenu overflows right edge
                    if (parentRect.right + submenuRect.width > viewportWidth) {
                        // Position to the left of parent instead
                        submenu.style.left = 'auto';
                        submenu.style.right = '100%';
                    }

                    // Check if submenu overflows bottom edge
                    if (parentRect.top + submenuRect.height > viewportHeight) {
                        // Align to bottom instead of top
                        submenu.style.top = 'auto';
                        submenu.style.bottom = '0';
                    }
                });
            });
        }
    }

    // Archive Tab (Only for active tabs)
    if (!isBookmarkOnly) {
        const archiveOption = document.createElement('div');
        archiveOption.className = 'context-menu-item';
        archiveOption.textContent = plural ? `Archive ${selectedCount} Tabs` : 'Archive Tab';
        archiveOption.setAttribute('role', 'menuitem');
        archiveOption.addEventListener('click', async () => {
            session.close();
            if (bulkActions) await bulkActions.archive(bulkActions.tabIds);
            else await Utils.archiveTab(tab.id); // Use the utility function
            finishBulkAction();
        });
        contextMenu.appendChild(archiveOption);
    }

    // Close Tab / Remove Bookmark
    const closeOption = document.createElement('div');
    closeOption.className = 'context-menu-item';
    closeOption.textContent = isBookmarkOnly
        ? 'Remove Bookmark'
        : plural ? `Close ${selectedCount} Tabs` : 'Close Tab';
    closeOption.setAttribute('role', 'menuitem');
    closeOption.addEventListener('click', async () => {
        session.close();
        if (bulkActions) await bulkActions.close(bulkActions.tabIds);
        else await closeTab(tabElement, tab, isPinned, isBookmarkOnly);
        finishBulkAction();
    });
    contextMenu.appendChild(closeOption);

    if (session.open(contextMenu)) {
        Utils.adjustMenuPosition(contextMenu, x, y);
        contextMenu.focus({ preventScroll: true });
    }
}

export async function showArchivedTabsPopup(popup) {
    const allArchived = await Utils.getArchivedTabs();
    if (!popup.isConnected || !popup.classList.contains('visible')) return;
    const list = popup.querySelector('.archived-tabs-list');
    const message = popup.querySelector('.no-archived-tabs-message');
    list.innerHTML = '';

    // Manual archives remain restorable even when automatic cleanup is off.
    message.style.display = 'block';
    if (allArchived.length === 0) {
        message.textContent = 'No archived tabs.';
        list.style.display = 'none';
    } else {
        message.textContent = '';
        list.style.display = 'block';
        allArchived.forEach(archivedTab => {
            const item = document.createElement('div');
            item.className = 'tab archived-item';
            item.title = `${archivedTab.name}\n${archivedTab.url}\nArchived: ${new Date(archivedTab.archivedAt).toLocaleString()}`;

            const favicon = document.createElement('img');
            setSidebarFavicon(favicon, archivedTab.url);
            favicon.className = 'tab-favicon';

            const details = document.createElement('div');
            details.className = 'tab-details';
            const titleSpan = document.createElement('span');
            titleSpan.className = 'tab-title-display';
            titleSpan.textContent = archivedTab.name;
            details.appendChild(titleSpan);

            const restoreButton = document.createElement('button');
            restoreButton.innerHTML = RESTORE_ICON;
            restoreButton.className = 'tab-restore';
            restoreButton.style.marginLeft = 'auto';
            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (restoreButton.disabled) return;
                restoreButton.disabled = true;
                try {
                    await Utils.restoreArchivedTab(archivedTab);
                } catch {
                    restoreButton.disabled = false;
                    message.textContent = 'Could not restore this tab.';
                }
            });

            item.appendChild(wrapSidebarFavicon(favicon));
            item.appendChild(details);
            item.appendChild(restoreButton);
            list.appendChild(item);
        });
    }
}

// Toast notification for URL copy success
export function showUrlCopyToast() {
    const toast = document.getElementById('urlCopyToast');
    if (!toast) return;

    // Clear any existing timeout
    if (toast.hideTimeout) {
        clearTimeout(toast.hideTimeout);
    }

    // Show the toast
    toast.classList.add('show');

    // Hide the toast after 2 seconds
    toast.hideTimeout = setTimeout(() => {
        toast.classList.remove('show');
        toast.hideTimeout = null;
    }, 2000);
}

export function showUndoToast(message, onUndo, duration = 5000) {
    document.getElementById('undoToast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'undoToast';
    toast.className = 'undo-toast';
    toast.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = message;
    const undoButton = document.createElement('button');
    undoButton.className = 'undo-toast-button';
    undoButton.type = 'button';
    undoButton.textContent = 'Undo';
    const hide = () => {
        clearTimeout(toast.hideTimeout);
        toast.remove();
    };
    undoButton.addEventListener('click', async () => {
        hide();
        try {
            await onUndo();
        } catch (error) {
            Logger.error('Undo failed:', error);
            alert(error.message);
        }
    });
    toast.append(text, undoButton);
    document.body.appendChild(toast);
    toast.hideTimeout = setTimeout(hide, duration);
}

export function setupQuickPinListener(moveTabToSpace, moveTabToPinned, moveTabToTemp, currentActiveSpaceId, setActiveSpaceFunc, activatePinnedTabByURL) {
    chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
        if (!isTrustedExtensionMessage(request, sender, chrome)) return;
        if (request.command === "quickPinToggle" || request.command === "toggleSpacePin") {
            const toggle = async () => {
                const tab = request.command === "quickPinToggle"
                    ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
                    : request.tabId && await chrome.tabs.get(request.tabId);
                if (!tab || tab.windowId !== (await chrome.windows.getCurrent()).id) return;

                const spaces = await spaceRequest('get', { discoverBookmarks: false });
                const temporary = spaces.find(space => space.temporaryTabs.includes(tab.id));
                if (temporary) {
                    await moveTabToPinned(temporary, tab);
                    return;
                }
                const bookmark = spaces.find(space => space.spaceBookmarks.includes(tab.id));
                if (bookmark) await moveTabToTemp(bookmark, tab);
            };
            void toggle().catch(error => Logger.error(Logger.context('Could not toggle the space pin.'), error));
        } else if (request.command === "copyCurrentUrl") {
            // SIDEBAR FALLBACK: Handle URL copy when sidebar is focused
            Logger.log(`[URLCopy] Sidebar fallback - copying URL: ${request.url}`);

            // Use clipboard API to copy the URL
            if (navigator.clipboard && request.url) {
                navigator.clipboard.writeText(request.url).then(() => {
                    Logger.log(`[URLCopy] Sidebar fallback succeeded: ${request.url}`);
                    showUrlCopyToast(); // Show success toast
                    sendResponse({ success: true });
                }).catch(err => {
                    Logger.error("[URLCopy] Sidebar fallback failed:", err);
                    sendResponse({ success: false, error: err.message });
                });
            } else {
                Logger.error("[URLCopy] Sidebar fallback failed: navigator.clipboard not available or no URL");
                sendResponse({ success: false, error: "Clipboard API not available" });
            }
            return true; // Indicate async response
        } else if (request.action === "urlCopySuccess") {
            // Show toast when URL copy succeeds in the offscreen document
            Logger.log("[URLCopy] Received success message from background script");
            showUrlCopyToast();
            sendResponse({ success: true });
            return false; // Synchronous response
        } else if (request.action === "activatePinnedTab") {
            Logger.log("[Sidebar] Activating pinned tab:", request);

            // Switch to the space if needed
            if (request.spaceId && currentActiveSpaceId !== request.spaceId) {
                Logger.log("[Sidebar] Switching to space:", request.spaceId, request.spaceName);
                setActiveSpaceFunc(request.spaceId);
            }

            // Use the utility function to handle pinned tab activation
            activatePinnedTabByURL(request.bookmarkUrl, request.spaceId, request.spaceName, request.bookmarkId || null);
        }
    });
}

// ============================================================================
// Unified Drag Helper Functions
// ============================================================================

/**
 * Unified function to find the element to insert after during drag-and-drop.
 * Replaces getDragAfterElementSwitcher, getDragAfterElement, and getDragAfterElementFavicon.
 *
 * @param {HTMLElement} container - The container element
 * @param {number} position - The mouse position (clientX for horizontal, clientY for vertical)
 * @param {Object} options - Configuration options
 * @param {string} options.axis - 'x' for horizontal, 'y' for vertical (default: 'y')
 * @param {string} options.selector - CSS selector for draggable elements
 * @param {string} options.placeholderSelector - CSS selector for placeholder element
 * @returns {HTMLElement|null} - The element to insert after, or null
 */
export function getDragAfterElement(container, position, options = {}) {
    const { axis = 'y', selector, placeholderSelector } = options;
    const draggableElements = [...container.querySelectorAll(selector)];

    // If no draggable elements exist, return the placeholder as a reference for empty containers
    if (draggableElements.length === 0) {
        return placeholderSelector ? container.querySelector(placeholderSelector) : null;
    }

    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = axis === 'x'
            ? position - box.left - box.width / 2
            : position - box.top - box.height / 2;

        if (offset < 0 && offset > closest.offset) {
            return { offset, element: child };
        }
        return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// ============================================================================
// Container Query Helpers
// ============================================================================

/**
 * Get a space element by its ID
 * @param {number|string} spaceId - The space ID
 * @returns {HTMLElement|null}
 */
export function getSpaceElement(spaceId) {
    return document.querySelector(`[data-space-id="${spaceId}"]`);
}

/**
 * Get both pinned and temporary containers for a space element
 * @param {HTMLElement} spaceElement - The space element
 * @returns {{pinned: HTMLElement|null, temp: HTMLElement|null}}
 */
export function getContainers(spaceElement) {
    return {
        pinned: spaceElement?.querySelector('[data-tab-type="pinned"]') ?? null,
        temp: spaceElement?.querySelector('[data-tab-type="temporary"]') ?? null
    };
}

/**
 * Get a tab element by its ID
 * @param {number|string} tabId - The tab ID
 * @returns {HTMLElement|null}
 */
export function getTabElement(tabId) {
    return document.querySelector(`[data-tab-id="${tabId}"]`);
}

/**
 * Get pinned container for a space element
 * @param {HTMLElement} spaceElement - The space element
 * @returns {HTMLElement|null}
 */
export function getPinnedContainer(spaceElement) {
    return spaceElement?.querySelector('[data-tab-type="pinned"]') ?? null;
}

/**
 * Get temporary container for a space element
 * @param {HTMLElement} spaceElement - The space element
 * @returns {HTMLElement|null}
 */
export function getTempContainer(spaceElement) {
    return spaceElement?.querySelector('[data-tab-type="temporary"]') ?? null;
}

// ============================================================================
// Active State Management
// ============================================================================

/**
 * Clear active state from all tabs and pinned favicons
 */
export function clearAllActiveStates() {
    document.querySelectorAll('.tab, .pinned-favicon')
        .forEach(el => el.classList.remove('active'));
}

// ============================================================================
// Drop Indicator Functions
// ============================================================================

/**
 * Hide all drop indicators in the document
 */
export function hideAllDropIndicators() {
    document.querySelectorAll('.drop-indicator-horizontal, .drop-indicator-vertical').forEach(element => {
        element.classList.remove('drop-indicator-horizontal', 'drop-indicator-vertical', 'above', 'below', 'left', 'right');
    });
}

/**
 * Show a drop indicator on the target element
 * @param {HTMLElement} targetElement - The element to show the indicator on
 * @param {string} position - Position: 'above', 'below', 'left', or 'right'
 * @param {boolean} isHorizontal - True for horizontal layout (favicons), false for vertical (tabs)
 */
export function showDropIndicator(targetElement, position, isHorizontal = false) {
    // First, hide all existing indicators
    hideAllDropIndicators();

    if (!targetElement) return;

    if (isHorizontal) {
        // For horizontal favicons (left/right positioning)
        targetElement.classList.add('drop-indicator-vertical');
        targetElement.classList.add(position); // 'left' or 'right'
    } else {
        // For vertical sidebar tabs (above/below positioning)
        targetElement.classList.add('drop-indicator-horizontal');
        targetElement.classList.add(position); // 'above' or 'below'
    }
}

/**
 * Get the drop position relative to an element
 * @param {HTMLElement} element - The target element
 * @param {number} clientX - Mouse X position
 * @param {number} clientY - Mouse Y position
 * @param {boolean} isHorizontal - True for horizontal layout, false for vertical
 * @returns {string|null} - Position: 'above', 'below', 'left', 'right', or null
 */
export function getDropPosition(element, clientX, clientY, isHorizontal = false) {
    if (!element) return null;

    const rect = element.getBoundingClientRect();

    if (isHorizontal) {
        // For horizontal favicons, use X position to determine left/right
        const centerX = rect.left + rect.width / 2;
        return clientX < centerX ? 'left' : 'right';
    } else {
        // For vertical tabs, use Y position to determine above/below
        const centerY = rect.top + rect.height / 2;
        return clientY < centerY ? 'above' : 'below';
    }
}

/**
 * Handle empty container drops consistently
 * @param {HTMLElement} container - The container element
 * @param {HTMLElement} draggingElement - The element being dragged
 * @param {HTMLElement} placeholder - The placeholder element
 * @returns {boolean} - True if handled successfully
 */
export function handleEmptyContainerDrop(container, draggingElement, placeholder) {
    if (!container || !draggingElement || !placeholder) return false;

    // Append element to container
    container.appendChild(draggingElement);

    // Hide placeholder appropriately based on type
    if (placeholder.classList.contains('pinned-placeholder-container')) {
        // For favorites area - use display none
        placeholder.style.display = 'none';
    } else if (placeholder.classList.contains('tab-placeholder')) {
        // For space containers - use hidden class
        placeholder.classList.add('hidden');
    }

    Logger.log('Handled empty container drop, hiding placeholder');
    return true;
}
