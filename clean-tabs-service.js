import { isProtectedFavorite } from './favorite-safety.js';
import { isTrustedExtensionMessage } from './message-security.js';
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

export function createCleanTabsHandler(chromeApi, store) {
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
        if (action !== 'preview' && action !== 'apply') return;
        const requested = action === 'apply' ? message.selected : [];
        if (!Array.isArray(requested) || requested.some(item => !Number.isInteger(item?.id)
            || item.id < 0 || typeof item.url !== 'string')) return;

        // Serialize membership checks with the model's writes. Native onRemoved
        // notifications reconcile only the tabs Chrome actually closes.
        store.run(async () => {
            const space = store.spaces.find(item => item.id === spaceId);
            if (!space || store.active[windowId] !== spaceId) throw new Error('The active space changed.');
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

            const results = await Promise.all([...new Map(requested.map(item => [item.id, item])).values()]
                .map(async ({ id, url }) => {
                    const tab = await chromeApi.tabs.get(id).catch(() => null);
                    if (revision !== protectionRevision || !isEligible(tab, scope) || tabUrl(tab) !== url) return false;
                    try {
                        await chromeApi.tabs.remove(id);
                        return true;
                    } catch {
                        return false;
                    }
                }));
            const closed = results.filter(Boolean).length;
            return { closed, remaining: results.length - closed };
        }).then(result => respond({ success: true, ...result }),
            () => respond({ success: false }));
        return true;
    };
}
