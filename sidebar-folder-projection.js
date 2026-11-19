import { FOLDER_CLOSED_ICON, FOLDER_CLOSED_DOTS_ICON, FOLDER_OPEN_ICON } from './icons.js';
import { Logger } from './logger.js';

export const collapsedFolderShownTabs = new WeakMap();

// Helper function to manage folder placeholder state
export function updateFolderPlaceholder(folderElement) {
    if (!folderElement) return;

    const folderContent = folderElement.querySelector(':scope > .folder-content');
    const placeholder = folderContent?.querySelector(':scope > .tab-placeholder');

    if (!folderContent || !placeholder) return;

    // Count actual tab elements (not placeholders)
    const tabElements = folderContent.querySelectorAll(':scope > .tab:not(.tab-placeholder), :scope > .folder');
    const isEmpty = tabElements.length === 0;

    if (isEmpty) {
        placeholder.classList.remove('hidden');
        Logger.log('Showing placeholder for empty folder');
    } else {
        placeholder.classList.add('hidden');
        Logger.log('Hiding placeholder for populated folder');
    }
}

function updateFolderIcon(folderElement) {
    if (!folderElement) return;
    const folderIcon = folderElement.querySelector('.folder-icon');
    if (!folderIcon) return;
    const isCollapsed = folderElement.classList.contains('collapsed');
    const hasOpenTabs = folderElement.classList.contains('has-open-tabs');
    folderIcon.innerHTML = isCollapsed
        ? (hasOpenTabs ? FOLDER_CLOSED_DOTS_ICON : FOLDER_CLOSED_ICON)
        : FOLDER_OPEN_ICON;
}

// Arc-like: when a folder is collapsed, show open bookmark tabs (active Chrome tabs) for that folder.
// Implementation detail: we MOVE the existing open tab elements between containers (no duplicates),
// so tab updates/active highlighting continue to work consistently.
const projectedTabAnchors = new WeakMap();
function restoreProjectedTab(tab, content) {
    const anchor = projectedTabAnchors.get(content)?.get(tab.dataset.bookmarkId || tab.dataset.tabId);
    if (anchor?.parentNode === content) anchor.replaceWith(tab);
    else content.appendChild(tab);
    projectedTabAnchors.get(content)?.delete(tab.dataset.bookmarkId || tab.dataset.tabId);
}
function projectFolderTab(tab, target) {
    const anchor = document.createComment('pinned tab position');
    anchor.bookmarkKey = tab.dataset.bookmarkId || tab.dataset.tabId;
    const content = tab.parentElement;
    if (!projectedTabAnchors.has(content)) projectedTabAnchors.set(content, new Map());
    projectedTabAnchors.get(content).set(tab.dataset.bookmarkId || tab.dataset.tabId, anchor);
    tab.before(anchor);
    target.appendChild(tab);
}

export function projectCollapsedFolder(folderElement, activeChromeTabId, showAllOpenTabsInCollapsedFolders) {
    if (!folderElement) return;
    const collapsedContainer = folderElement.querySelector('.folder-collapsed-tabs');
    const folderContent = folderElement.querySelector(':scope > .folder-content');
    if (!collapsedContainer || !folderContent) return;

    const isCollapsed = folderElement.classList.contains('collapsed');

    for (const tab of collapsedContainer.querySelectorAll(':scope > .tab')) {
        restoreProjectedTab(tab, folderContent);
    }
    if (isCollapsed) {
        if (showAllOpenTabsInCollapsedFolders) {
            // Arcify mode: show all open (non-bookmark-only) tabs even when folder is collapsed.
            const openTabs = Array.from(folderContent.querySelectorAll(':scope > .tab'))
                .filter(t => !t.classList.contains('bookmark-only') && t.dataset.tabId);
            openTabs.forEach(t => projectFolderTab(t, collapsedContainer));
        } else {
            // Arc mode: show tabs that are active OR were previously active while folder was collapsed.
            // This list resets when user manually opens/closes the folder.
            let shownTabIds = collapsedFolderShownTabs.get(folderElement);

            // Also seed the currently active tab if it's in this folder (handles initialization case).
            if (activeChromeTabId) {
                const activeTabEl = folderContent.querySelector(`:scope > .tab[data-tab-id="${activeChromeTabId}"]:not(.bookmark-only)`);
                if (activeTabEl) {
                    if (!shownTabIds) {
                        shownTabIds = new Set();
                        collapsedFolderShownTabs.set(folderElement, shownTabIds);
                    }
                    shownTabIds.add(activeChromeTabId);
                }
            }

            if (shownTabIds && shownTabIds.size > 0) {
                shownTabIds.forEach(tabId => {
                    const tabEl = folderContent.querySelector(`:scope > .tab[data-tab-id="${tabId}"]:not(.bookmark-only)`);
                    if (tabEl) {
                        projectFolderTab(tabEl, collapsedContainer);
                    }
                });
            }
        }
    }

    // Arc-like: indicate collapsed folder contains an open tab (in Arc mode this only happens for active tab).
    const hasOpenTabs = isCollapsed && Boolean(collapsedContainer.querySelector('.tab:not(.bookmark-only)'));
    folderElement.classList.toggle('has-open-tabs', hasOpenTabs);
    updateFolderIcon(folderElement);

    // Recompute placeholder visibility now that DOM contents may have changed.
    updateFolderPlaceholder(folderElement);
}

export function removeProjectedAnchor(content, element) {
    const key = element.dataset.bookmarkId || element.dataset.tabId;
    const anchors = projectedTabAnchors.get(content);
    anchors?.get(key)?.remove();
    anchors?.delete(key);
}
