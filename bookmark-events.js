import { BOOKMARK_ROOT_KEY } from './localstorage.js';
import { forgetRemovedSpacePinNames } from './space-bookmarks.js';

const COALESCE_MS = 100;
let timer = null;

async function isRelevant(ids, root) {
    for (const original of ids.filter(Boolean)) {
        let id = String(original);
        for (let depth = 0; depth < 16; depth++) {
            if (id === String(root)) return true;
            const [node] = await chrome.bookmarks.get(id).catch(() => []);
            if (!node?.parentId) break;
            id = String(node.parentId);
        }
    }
    return false;
}

function notify(reason) {
    clearTimeout(timer);
    timer = setTimeout(() => {
        try {
            const sent = chrome.runtime.sendMessage({ action: 'arcifyBookmarksChanged', reason });
            sent?.catch?.(() => {});
        } catch { /* No sidebar is normally open. */ }
    }, COALESCE_MS);
}

async function handle(ids, reason) {
    try {
        const { [BOOKMARK_ROOT_KEY]: root } = await chrome.storage.local.get(BOOKMARK_ROOT_KEY);
        if (root && await isRelevant(ids, root)) {
            notify(reason === 'removed' && String(ids[0]) === root ? 'root-removed' : reason);
        }
    } catch {
        // A later read will report a bookmark or storage failure to the sidebar.
    }
}

export function registerBookmarkListeners() {
    chrome.bookmarks.onCreated.addListener((id, node) => handle([node?.parentId], 'created'));
    chrome.bookmarks.onRemoved.addListener((id, info) => {
        forgetRemovedSpacePinNames(id, info?.node).catch(() => {});
        return handle([id, info?.parentId], 'removed');
    });
    chrome.bookmarks.onMoved.addListener((id, info) => handle([id, info?.parentId, info?.oldParentId], 'moved'));
    chrome.bookmarks.onChanged.addListener(id => handle([id], 'changed'));
    chrome.bookmarks.onChildrenReordered?.addListener((id) => handle([id], 'reordered'));
    chrome.bookmarks.onImportBegan?.addListener(() => notify('import-started'));
    chrome.bookmarks.onImportEnded?.addListener(() => notify('import-finished'));
}
