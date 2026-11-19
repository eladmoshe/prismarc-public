import { getPinnedContainer, getTempContainer } from './domManager.js';
import { canonicalOrderFromDisplay } from './sidebar-tabs.js';

export const bookmarkOrderBaselines = new Map();

export function uniqPreserveOrder(ids) {
    const out = [];
    const seen = new Set();
    for (const id of ids) {
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

// Reinsert projected rows at their original comment anchors for bookmark ordering.
function bookmarkRows(content) {
    const folder = content.parentElement;
    const projected = folder?.classList.contains('folder')
        ? [...folder.querySelector(':scope > .folder-collapsed-tabs').children] : [];
    return [...content.childNodes].map(node => {
        if (node.nodeType === Node.COMMENT_NODE && node.bookmarkKey) {
            return projected.find(el => (el.dataset.bookmarkId || el.dataset.tabId) === node.bookmarkKey);
        }
        return node.nodeType === Node.ELEMENT_NODE ? node : null;
    }).filter(el => el?.classList.contains('folder') || el?.classList.contains('tab'));
}

function orderedBookmarkKeys(content, pendingElement) {
    return bookmarkRows(content).map(el => {
        if (el === pendingElement && !el.dataset.bookmarkId) return '$new';
        return el.dataset.bookmarkId || null;
    }).filter(Boolean).map(String);
}

export function bookmarkParentIdForContent(content, rootId) {
    return String(content.closest('.folder')?.dataset.bookmarkId || rootId);
}

export function makeBookmarkDropOperation({ sourceContent, targetContent, draggingElement, rootId, tab }) {
    const bookmarkId = draggingElement.dataset.bookmarkId || null;
    const sourceParentId = bookmarkId ? bookmarkParentIdForContent(sourceContent, rootId) : null;
    const targetParentId = bookmarkParentIdForContent(targetContent, rootId);
    const parentIds = [...new Set([sourceParentId, targetParentId].filter(Boolean))];
    const parents = parentIds.map(parentId => {
        const content = parentId === targetParentId ? targetContent : sourceContent;
        const displayIds = orderedBookmarkKeys(content, draggingElement);
        const desiredCanonicalIds = canonicalOrderFromDisplay(displayIds, false);
        const expectedCanonicalIds = bookmarkOrderBaselines.get(parentId);
        if (!expectedCanonicalIds) throw new Error('The bookmark order baseline is unavailable. Refresh and retry.');
        return { parentId, expectedCanonicalIds: [...expectedCanonicalIds], desiredCanonicalIds };
    });
    let relocation = null;
    if (!bookmarkId) {
        relocation = { kind: 'create', parentId: targetParentId, title: tab.title, url: draggingElement.dataset.pinnedUrl || tab.url };
    } else if (sourceParentId !== targetParentId) {
        relocation = { kind: 'move', bookmarkId, parentId: targetParentId };
    }
    return { parents, relocation };
}

export function getFlattenedPinnedSectionTabIds(spaceElement) {
    const pinnedContainer = getPinnedContainer(spaceElement);
    if (!pinnedContainer) return [];
    const walk = content => bookmarkRows(content).filter(row => row.dataset.bookmarkId).flatMap(child =>
        child.classList.contains('folder')
            ? walk(child.querySelector(':scope > .folder-content'))
            : child.dataset.tabId ? [Number(child.dataset.tabId)] : []
    );
    return uniqPreserveOrder(walk(pinnedContainer));
}

export function getTempSectionTabIds(spaceElement) {
    const tempContainer = getTempContainer(spaceElement);
    if (!tempContainer) return [];
    return uniqPreserveOrder(
        Array.from(tempContainer.querySelectorAll('.tab[data-tab-id]')).map(el => parseInt(el.dataset.tabId))
    );
}
