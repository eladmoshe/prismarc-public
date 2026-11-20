import { isProtectedFavorite } from './favorite-safety.js';
import { isTrustedExtensionMessage } from './message-security.js';
import { searchableUrl } from './quick-switcher-search.js';
import { getSpaceBookmarkFolder } from './space-bookmarks.js';
import { TAB_FOCUS_TIMES, tabLastViewed } from './tab-switcher-tabs.js';
import { Utils } from './utils.js';

async function favoriteUrlKeys(bookmarks, space) {
    const folder = await getSpaceBookmarkFolder(space);
    const [tree] = await bookmarks.getSubTree(folder.id);
    if (!tree) throw new Error('The bookmark folder is unavailable.');
    const keys = new Set();
    function collect(node) {
        if (node.url) keys.add(Utils.getPinnedUrlKey(node.url));
        else node.children?.forEach(collect);
    }
    collect(tree);
    return keys;
}

function isEligible(tab, { window, temporary, saved, bindings, favoriteUrls }) {
    return tab?.windowId === window.id && Boolean(tab.incognito) === Boolean(window.incognito)
        && temporary.has(tab.id) && !isProtectedFavorite(tab, saved, bindings, favoriteUrls)
        && (!tab.pendingUrl || !favoriteUrls.has(Utils.getPinnedUrlKey(tab.pendingUrl)));
}

function tabUrl(tab) {
    return tab.pendingUrl || tab.url || '';
}

async function discardUnusedNewTab(tabs, windowId, placeholder) {
    const live = await tabs.query({ windowId });
    const current = live.find(tab => tab.id === placeholder.id);
    if (live.length > 1 && current && !current.active && tabUrl(current) === tabUrl(placeholder)) {
        await tabs.remove(current.id);
    }
}

// Use surviving neighbors so intervening closes and retries preserve both the
// native tab strip and the independently ordered temporary list.
function insertionPoint(original, live, oldId) {
    const position = original.indexOf(oldId);
    const livePositions = new Map(live.map((id, index) => [id, index]));
    for (let i = position + 1; i < original.length; i++) {
        if (livePositions.has(original[i])) return livePositions.get(original[i]);
    }
    for (let i = position - 1; i >= 0; i--) {
        if (livePositions.has(original[i])) return livePositions.get(original[i]) + 1;
    }
    return Math.min(Math.max(position, 0), live.length);
}

async function reopenCleanBatch(chromeApi, space, windowId, batch) {
    const live = (await chromeApi.tabs.query({ windowId })).sort((a, b) => a.index - b.index).map(tab => tab.id);
    let reopened = 0;
    for (const [oldId, url] of batch.pages) {
        const index = insertionPoint(batch.stripOrder, live, oldId);
        let tab;
        try {
            tab = await chromeApi.tabs.create({ windowId, index, url, active: false });
        } catch {
            continue; // Retain failed creations for a retry until expiry.
        }
        batch.pages.delete(oldId);
        live.splice(tab.index, 0, tab.id);
        batch.stripOrder[batch.stripOrder.indexOf(oldId)] = tab.id;
        const spaceIndex = insertionPoint(batch.spaceOrder, space.temporaryTabs, oldId);
        space.temporaryTabs.splice(spaceIndex, 0, tab.id);
        batch.spaceOrder[batch.spaceOrder.indexOf(oldId)] = tab.id;
        reopened++;
    }
    // onCreated runs behind this store operation, sees the assigned owner and
    // persists the model through the same path as an ordinary tab creation.
    return { reopened, remaining: batch.pages.size };
}

export function createCleanTabsHandler(chromeApi, store) {
    // Shorter than the service worker idle timeout. URLs never enter storage.
    const undoDuration = 20_000;
    const lastClean = new Map();
    function forget(windowId) {
        clearTimeout(lastClean.get(windowId)?.timer);
        lastClean.delete(windowId);
    }
    chromeApi.windows.onRemoved?.addListener(forget);
    let protectionRevision = 0;
    const reviseProtection = () => { protectionRevision++; };
    for (const event of [chromeApi.bookmarks.onCreated, chromeApi.bookmarks.onMoved,
        chromeApi.bookmarks.onChanged, chromeApi.bookmarks.onRemoved]) {
        event?.addListener(reviseProtection);
    }
    chromeApi.storage.onChanged?.addListener((changes, area) => {
        if (area === 'local' && changes.pinnedTabStatesById) reviseProtection();
    });
    return (message, sender, respond) => {
        if (!isTrustedExtensionMessage(message, sender, chromeApi) || message.type !== 'cleanTabs'
            || sender.url !== chromeApi.runtime.getURL('sidebar.html')) return;
        const { windowId, spaceId, action } = message;
        if (!Number.isInteger(windowId) || windowId < 0 || typeof spaceId !== 'string'
            || (sender.tab && sender.tab.windowId !== windowId)) return;
        if (!['preview', 'apply', 'undo'].includes(action) ||
            (action === 'undo' && typeof message.undoId !== 'string')) return;
        const requested = action === 'apply' ? message.selected : [];
        if (!Array.isArray(requested) || requested.some(item => !Number.isInteger(item?.id)
            || item.id < 0 || typeof item.url !== 'string')) return;

        // Serialize membership checks with the model's writes. Native onRemoved
        // notifications reconcile only the tabs Chrome actually closes.
        store.run(async () => {
            const space = store.spaces.find(item => item.id === spaceId);
            if (!space) throw new Error('The space is unavailable.');
            if (action === 'undo') {
                const batch = lastClean.get(windowId);
                if (!batch || batch.id !== message.undoId || batch.spaceId !== spaceId || batch.expiresAt <= Date.now()) {
                    return { expired: true };
                }
                const result = await reopenCleanBatch(chromeApi, space, windowId, batch);
                if (!result.remaining) forget(windowId);
                return result;
            }
            if (store.active[windowId] !== spaceId) throw new Error('The active space changed.');
            const revision = protectionRevision;
            const [window, bindings, favoriteUrls] = await Promise.all([
                chromeApi.windows.get(windowId),
                Utils.getPinnedTabStates(),
                favoriteUrlKeys(chromeApi.bookmarks, space)
            ]);
            if (window.type !== 'normal') throw new Error('This window is unavailable.');
            const scope = { window, bindings, favoriteUrls, temporary: new Set(space.temporaryTabs),
                saved: new Set(space.spaceBookmarks) };

            if (action === 'preview') {
                const [tabs, session] = await Promise.all([
                    chromeApi.tabs.query({ windowId }), chromeApi.storage.session.get(TAB_FOCUS_TIMES),
                ]);
                const candidates = tabs.filter(tab => isEligible(tab, scope)).map(tab => ({
                    id: tab.id, url: tabUrl(tab), lastViewed: tabLastViewed(tab, session[TAB_FOCUS_TIMES]),
                }));
                // Unknown times follow recorded views. Tab IDs break timestamp ties.
                candidates.sort((left, right) => Number(!left.lastViewed) - Number(!right.lastViewed)
                    || left.lastViewed - right.lastViewed || left.id - right.id);
                return { candidates };
            }

            const { tabs } = chromeApi;
            const stripOrder = (await tabs.query({ windowId })).sort((a, b) => a.index - b.index).map(tab => tab.id);
            const spaceOrder = space.temporaryTabs.slice();
            const requestedById = new Map(requested.map(item => [item.id, item]));
            const windowTabs = new Set(stripOrder);
            const confirmed = [...requestedById.values()].filter(({ id }) => windowTabs.has(id));
            const last = confirmed.pop();
            const closeCandidate = async ({ id, url }, preserveWindow = false) => {
                const eligible = tab => revision === protectionRevision && isEligible(tab, scope) && tabUrl(tab) === url;
                let placeholder;
                try {
                    const live = preserveWindow ? await tabs.query({ windowId }) : null;
                    let tab = await tabs.get(id);
                    if (!eligible(tab)) return false;
                    if (live?.length === 1 && live[0].id === id) {
                        placeholder = await tabs.create({ windowId, active: false });
                        tab = await tabs.get(id);
                    }
                    if (eligible(tab)) {
                        await tabs.remove(id);
                        return { id, url: searchableUrl(tabUrl(tab)) };
                    }
                } catch { /* Keep the other successful closes in the batch. */ }
                if (placeholder) await discardUnusedNewTab(tabs, windowId, placeholder).catch(() => {});
                return false;
            };
            const results = await Promise.all(confirmed.map(item => closeCandidate(item)));
            // Keep the last candidate open until earlier closes have settled.
            // A skipped or failed close can leave a native tab to keep the sidebar open.
            if (last) results.push(await closeCandidate(last, true));
            const closed = results.filter(Boolean);
            const result = { closed: closed.length, remaining: requestedById.size - closed.length };
            if (closed.length) {
                forget(windowId);
                const pages = new Map(closed.filter(item => item.url).map(item => [item.id, item.url]));
                if (pages.size) {
                    const id = crypto.randomUUID();
                    const expiresAt = Date.now() + undoDuration;
                    const timer = setTimeout(() => forget(windowId), undoDuration);
                    timer.unref?.();
                    lastClean.set(windowId, { id, spaceId, expiresAt, stripOrder, spaceOrder, pages, timer });
                    result.undo = { id, expiresAt, count: pages.size };
                }
            }
            return result;
        }).then(result => respond({ success: true, ...result }),
            () => respond({ success: false }));
        return true;
    };
}
