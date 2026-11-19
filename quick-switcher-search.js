// Query Chrome's own stores on demand. Nothing here is indexed or persisted.
const DAY = 24 * 60 * 60 * 1000;
const sourceOrder = { tab: 0, bookmark: 1, history: 2 };
const safeChromePages = new Set(['newtab', 'new-tab-page', 'settings', 'history', 'bookmarks', 'downloads', 'extensions']);

export function searchableUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol === 'chrome:') {
            // Non-special schemes preserve host casing. Inspect the raw authority
            // too, so an empty credential or port delimiter cannot be normalized away.
            if (!/^chrome:\/\/[a-z0-9-]+(?:[/?#]|$)/i.test(value) ||
                /[\s\p{Cc}\p{Cf}\\]|%(?![\da-f]{2})/iu.test(value)) return null;
            const host = url.hostname.toLowerCase();
            if (!safeChromePages.has(host)) return null;
            url.hostname = host;
            if (!url.pathname) url.pathname = '/';
            return url.href;
        }
        if (['http:', 'https:', 'file:', 'ftp:'].includes(url.protocol) ||
            (url.protocol === 'about:' && url.pathname === 'blank')) return url.href;
    } catch { /* A missing or malformed URL is not a result. */ }
    return null;
}

export function urlIdentity(value) {
    const href = searchableUrl(value);
    if (!href) return null;
    const url = new URL(href);
    url.hash = '';
    return url.href;
}

const callbackResponseKeys = ['code', 'state', 'error', 'access_token', 'id_token'];

function oktaDestination(href) {
    const url = new URL(href);
    if (!['http:', 'https:'].includes(url.protocol) ||
        !['okta.com', 'oktapreview.com', 'okta-emea.com'].some(host =>
            url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    if (url.pathname === '/enduser/callback') {
        const fragment = new URLSearchParams(url.hash.slice(1));
        if (callbackResponseKeys.some(key => url.searchParams.has(key) || fragment.has(key))) {
            url.search = ''; url.hash = '';
            return { callback: true, title: 'Okta sign-in', detail: 'Sign-in callback', displayUrl: url.href };
        }
    }
    if (url.pathname === '/app/UserHome') {
        // Remove only issuer decoration, without reserializing unknown query fields.
        if (url.searchParams.has('iss')) {
            url.search = url.search.slice(1).split('&').filter(field => !new URLSearchParams(field).has('iss')).join('&');
        }
        const displayUrl = url.href;
        const detail = `Dashboard${url.search ? ` ${url.search}` : ''}`;
        url.hash = '';
        return { identity: url.href, title: 'Okta dashboard', detail, displayUrl };
    }
    return null;
}

export function historyDestinationIdentity(href) {
    return oktaDestination(href)?.identity || urlIdentity(href);
}

export async function resolveSearchWindow(windowId, chromeApi = globalThis.chrome) {
    if (Number.isInteger(windowId) && windowId >= 0) {
        try {
            const window = await chromeApi.windows.get(windowId);
            if (window.type === 'normal') return window;
        } catch { /* The originating window may have been closed. */ }
    }
    const window = await chromeApi.windows.getLastFocused({ windowTypes: ['normal'] });
    if (window.type !== 'normal') throw new Error('No browser window is available');
    return window;
}

function matchScore(item, query) {
    if (!query) return 0;
    const title = item.title.toLowerCase();
    const url = item.url.toLowerCase();
    let score = title === query ? 300 : title.startsWith(query) ? 180 : title.includes(query) ? 100 : 0;
    score += url.includes(query) ? 40 : 0;
    return score + (item.source === 'tab' ? 30 : item.source === 'bookmark' ? 10 : 0);
}

function displayTitle(title, href) {
    const url = new URL(href);
    const destination = oktaDestination(href);
    const detail = destination?.detail || '';
    const displayUrl = destination?.displayUrl || href;
    const cleaned = (title || '').replace(/^\(\d+\)\s*/, '').trim();
    const rawDestinationTitle = destination && (searchableUrl(cleaned) !== null || cleaned === href.replace(/^https?:\/\//, ''));
    const genericTitle = !cleaned || cleaned === href || rawDestinationTitle ||
        /^(home(?:\s*[/|–—-]\s*(?:x|twitter))?|x|twitter|untitled|new tab|loading[.…]*)$/i.test(cleaned);
    if (!genericTitle) return { title: cleaned, genericTitle: false, detail, displayUrl };
    if (destination) return { title: destination.title, genericTitle: false, destinationFallback: true, detail, displayUrl };
    if (/^(?:(?:www|mobile|m)\.)?(?:x\.com|twitter\.com)$/.test(url.hostname)) {
        const post = url.pathname.match(/^\/([\w]+)\/status\/(\d+)(?:\/(photo|video)\/(\d+))?\/?$/i);
        if (post) return { title: `${post[1] === 'i' ? 'X' : `@${post[1]}`} · Post ${post[2]}`,
            genericTitle: true, detail: post[3] ? `${post[3] === 'photo' ? 'Photo' : 'Video'} ${post[4]}` : '' };
        if (/^\/(?:home)?\/?$/.test(url.pathname)) return { title: 'X · Home', genericTitle: true, detail: '' };
    }
    // Chrome may have saved only a generic SPA title. Use its URL rather than inventing page content.
    return { title: `${url.host}${url.pathname === '/' ? '' : url.pathname}${url.search}` || href,
        genericTitle: true, detail: '' };
}

export function mergeSearchResults({ tabs = [], bookmarks = [], history = [], spaces = [] }, query, context, now = Date.now()) {
    const text = query.trim().toLowerCase();
    const terms = text.split(/\s+/).filter(Boolean);
    const candidates = [];
    for (const tab of tabs) {
        if (Boolean(tab.incognito) !== Boolean(context.incognito)) continue;
        const url = searchableUrl(tab.pendingUrl || tab.url);
        if (!url) continue;
        const display = displayTitle(tab.title, url);
        const matched = terms.every(term => `${tab.title || ''} ${display.title} ${url}`.toLowerCase().includes(term));
        const space = spaces.find(space => [...(space.spaceBookmarks || []), ...(space.temporaryTabs || [])].includes(tab.id));
        candidates.push({ id: `tab-${tab.id}`, source: 'tab', tabId: tab.id, windowId: tab.windowId,
            ...display, matched, url, context: space?.name || (tab.windowId === context.id ? 'This window' : 'Other window'),
            time: tab.lastAccessed || 0, currentWindow: tab.windowId === context.id });
    }
    for (const bookmark of bookmarks) {
        const url = searchableUrl(bookmark.url);
        if (url) candidates.push({ id: `bookmark-${bookmark.id}`, source: 'bookmark', ...displayTitle(bookmark.title, url), matched: true,
            url, context: 'Saved bookmark', time: bookmark.dateLastUsed || bookmark.dateAdded || 0 });
    }
    for (const page of history) {
        const url = searchableUrl(page.url);
        if (url && !oktaDestination(url)?.callback) candidates.push({ id: `history-${page.id}`, source: 'history', ...displayTitle(page.title, url), matched: true,
            url, historyUrls: [page.url], context: 'Visited', time: page.lastVisitTime || 0 });
    }
    // Ignore section fragments when grouping; retain the winning entry's full URL.
    // Prefer an open tab for a duplicate URL; prefer the invoking window among URL twins.
    candidates.sort((a, b) => sourceOrder[a.source] - sourceOrder[b.source] ||
        Number(Boolean(b.currentWindow)) - Number(Boolean(a.currentWindow)) || b.time - a.time);
    const merged = new Map();
    const historyDestinations = new Map();
    for (const item of candidates) {
        const identity = urlIdentity(item.url);
        const destination = historyDestinationIdentity(item.url);
        // Relax only history duplicates. Explicit tabs/bookmarks retain their own URL identities.
        const previous = merged.get(identity) || (item.source === 'history' && historyDestinations.get(destination));
        if (previous) {
            if (previous.source === 'history') previous.historyUrls = [...new Set([...previous.historyUrls, ...item.historyUrls])];
            previous.bookmarked ||= item.source === 'bookmark';
            previous.time = Math.max(previous.time, item.time);
            previous.matched ||= item.matched;
            if ((previous.genericTitle || previous.destinationFallback) && !item.genericTitle && !item.destinationFallback) {
                previous.title = item.title;
                previous.genericTitle = false;
                previous.destinationFallback = false;
                previous.detail = item.detail;
            }
        } else {
            const result = { ...item, bookmarked: item.source === 'bookmark' };
            merged.set(identity, result);
            if (!historyDestinations.has(destination)) historyDestinations.set(destination, result);
        }
    }
    const genericHistoryHosts = new Set();
    return [...merged.values()].filter(item => item.matched).sort((a, b) =>
        // Switching to a matching open tab takes priority over opening a saved/visited page.
        Number(b.source === 'tab') - Number(a.source === 'tab') ||
        // Keep live tabs/bookmarks available; generic history should not crowd out useful recent pages.
        (!text ? Number(a.source === 'history' && a.genericTitle) - Number(b.source === 'history' && b.genericTitle) : 0) ||
        matchScore(b, text) - matchScore(a, text) || b.time - a.time ||
        sourceOrder[a.source] - sourceOrder[b.source] || a.title.localeCompare(b.title))
        .filter(item => {
            if (text || item.source !== 'history' || !item.genericTitle) return true;
            const host = new URL(item.url).hostname.replace(/^(www|mobile|m)\./, '');
            if (genericHistoryHosts.has(host)) return false;
            genericHistoryHosts.add(host);
            return true;
        })
        .slice(0, 30).map(item => ({ ...item, age: item.time ? Math.max(0, now - item.time) : null }));
}

export async function searchBrowser(query, context, chromeApi = globalThis.chrome) {
    const text = query.trim();
    const now = Date.now();
    const names = ['Tabs', 'Bookmarks', 'History', 'Spaces'];
    const responses = await Promise.allSettled([
        Promise.resolve().then(() => chromeApi.tabs.query({})),
        Promise.resolve().then(() => text ? chromeApi.bookmarks.search(text) : chromeApi.bookmarks.getRecent(30)),
        Promise.resolve().then(() => context.incognito ? [] : chromeApi.history.search({
            text, startTime: text ? 0 : now - 30 * DAY, maxResults: 100,
        })),
        Promise.resolve().then(async () => {
            const response = await chromeApi.runtime.sendMessage({ type: 'spaceStore', action: 'get', discoverBookmarks: false });
            if (!response?.success) throw new Error('Could not read tab spaces');
            return response.spaces;
        }),
    ]);
    const value = (index, fallback) => responses[index].status === 'fulfilled' ? responses[index].value : fallback;
    return {
        results: mergeSearchResults({ tabs: value(0, []), bookmarks: value(1, []), history: value(2, []),
            spaces: value(3, []) || [] }, text, context, now),
        unavailable: responses.flatMap((response, index) => response.status === 'rejected' && index < 3 ? [names[index]] : []),
    };
}

export async function activateBrowserResult(item, context, newTab = false, chromeApi = globalThis.chrome) {
    const url = searchableUrl(item.url);
    if (!url) throw new Error('This URL cannot be opened');
    const identity = urlIdentity(url);
    const source = await resolveSearchWindow(context.id, chromeApi);
    if (Boolean(source.incognito) !== Boolean(context.incognito)) throw new Error('Browser context changed');
    if (!newTab) {
        const tabs = await chromeApi.tabs.query({});
        const matches = tabs.filter(tab => Boolean(tab.incognito) === Boolean(context.incognito) &&
            urlIdentity(tab.pendingUrl || tab.url) === identity);
        matches.sort((a, b) => Number(b.id === item.tabId) - Number(a.id === item.tabId) ||
            Number(b.windowId === source.id) - Number(a.windowId === source.id));
        if (matches.length) {
            const tab = await chromeApi.tabs.update(matches[0].id, { active: true });
            // An already-active tab in another window may emit no activation event.
            // Explicitly reveal its owner through the existing authoritative writer.
            const response = await chromeApi.runtime.sendMessage({ type: 'spaceStore', action: 'get', discoverBookmarks: false });
            if (!response?.success) throw new Error('Could not read tab spaces');
            const owner = response.spaces.find(space =>
                [...(space.spaceBookmarks || []), ...(space.temporaryTabs || [])].includes(tab.id));
            if (owner) {
                const activated = await chromeApi.runtime.sendMessage({ type: 'spaceStore', action: 'activate',
                    spaceId: owner.id, windowId: tab.windowId });
                if (!activated?.success) throw new Error('Could not reveal tab space');
            }
            await chromeApi.windows.update(tab.windowId, { focused: true });
            return tab;
        }
    }
    const [opener] = await chromeApi.tabs.query({ active: true, windowId: source.id });
    const tab = await chromeApi.tabs.create({ url, windowId: source.id, active: true,
        ...(opener ? { openerTabId: opener.id } : {}) });
    // SpaceStore already assigns native new tabs using their opener/selected space.
    await chromeApi.windows.update(source.id, { focused: true });
    return tab;
}

// Delete only exact native URLs represented by this history row, never unseen variants.
export async function deleteHistoryResult(item, context, chromeApi = globalThis.chrome) {
    const urls = item?.historyUrls;
    const href = searchableUrl(item?.url);
    const identity = href && historyDestinationIdentity(href);
    if (context?.incognito !== false || item?.source !== 'history' || !Array.isArray(urls) ||
        !href || !urls.length || urls.length > 100 || !urls.some(url => searchableUrl(url) === href) ||
        urls.some(url => typeof url !== 'string' || !searchableUrl(url) ||
            historyDestinationIdentity(url) !== identity)) throw new Error('Not a deletable history result');
    const source = await resolveSearchWindow(context.id, chromeApi);
    if (source.incognito) throw new Error('Browser context changed');
    const unique = [...new Set(urls)];
    const responses = await Promise.allSettled(unique.map(url =>
        Promise.resolve().then(() => chromeApi.history.deleteUrl({ url }))));
    return {
        deleted: unique.filter((url, index) => responses[index].status === 'fulfilled'),
        failed: unique.filter((url, index) => responses[index].status === 'rejected'),
    };
}
