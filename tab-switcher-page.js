import { applyPopupSpaceTheme } from './space-client.js';
import { TAB_SWITCHER_SESSION } from './tab-switcher.js';
import { describeOpenTab } from './tab-switcher-tabs.js';
import { TAB_SWITCHER_PAGE_PREVIEWS, TAB_SWITCHER_PREVIEW_CACHE } from './tab-switcher-previews.js';
import { Utils } from './utils.js';

const token = location.hash.slice(1);
const list = document.getElementById('tabs');
const status = document.getElementById('switcher-status');
const selectedTitle = document.getElementById('selected-title');
let tiles = new Map();
let renderedIds;
let finished = false;

function request(action, tabId) {
    if (finished) return;
    const ending = action === 'commit' || action === 'cancel';
    if (ending) finished = true;
    chrome.runtime.sendMessage({ type: TAB_SWITCHER_SESSION, action, tabId }).then(response => {
        if (!response?.success) throw new Error('Could not switch tabs');
    }).catch(() => {
        finished = false;
        status.textContent = 'Could not switch tabs.';
    });
}

window.addEventListener('keydown', event => {
    if (event.isComposing || event.ctrlKey || event.metaKey) return;
    if (event.altKey && event.key === 'Tab') {
        event.preventDefault();
        request(event.shiftKey ? 'previous' : 'next');
    } else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        request(event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 'next' : 'previous');
    } else if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        request(event.key === 'Enter' ? 'commit' : 'cancel');
    }
});
window.addEventListener('focus', () => list.focus({ preventScroll: true }));

function markSelection(state) {
    const selected = tiles.get(state.selectedId);
    for (const [id, tile] of tiles) {
        const active = id === state.selectedId;
        tile.dataset.selected = String(active);
        tile.setAttribute('aria-selected', String(active));
    }
    selectedTitle.textContent = selected?.getAttribute('aria-label') || '';
    if (selected) list.setAttribute('aria-activedescendant', selected.id);
    else list.removeAttribute('aria-activedescendant');
}

const SITE_HUES = [13, 38, 70, 147, 181, 215, 255, 286, 327];

function siteAppearance(tab, label) {
    let url;
    try { url = new URL(tab.url || tab.pendingUrl); } catch { /* Unparseable URLs use the title. */ }
    const web = url && ['http:', 'https:'].includes(url.protocol);
    const settings = url?.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id &&
        url.pathname === '/options.html';
    const host = web ? url.hostname.replace(/^www\./i, '') : '';
    const seed = host || label.title;
    let hash = 0;
    for (const char of seed) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    const hue = SITE_HUES[hash % SITE_HUES.length];
    const mark = seed.match(/[\p{L}\p{N}]/u)?.[0].toLocaleUpperCase() || '·';

    // Chrome resolves its own cached favicon for the page URL. Never load tab.favIconUrl.
    let icon;
    if (settings) icon = chrome.runtime.getURL('assets/icon-48.png');
    if (web) {
        url.username = '';
        url.password = '';
        url.hash = '';
        icon = Utils.getFaviconUrl(url.href, '32');
    }
    return {
        hue, mark, icon, settings,
        fallback: web ? 'No recent preview for this tab' : 'Page preview unavailable',
    };
}

function tabTile(tab) {
    const label = describeOpenTab(tab);
    const { hue, mark, icon, settings, fallback } = siteAppearance(tab, label);
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.id = 'tab-' + tab.id;
    tile.className = 'tab-tile';
    tile.tabIndex = -1;
    tile.setAttribute('role', 'option');
    tile.setAttribute('aria-label', label.title);
    if (label.address) tile.setAttribute('aria-description', label.address);
    tile.style.setProperty('--site-hue', hue);
    tile.dataset.previewFallback = fallback;
    tile.title = fallback;

    const art = document.createElement('span');
    art.className = 'tile-art';
    art.setAttribute('aria-hidden', 'true');
    const siteMark = document.createElement('span');
    siteMark.className = 'tile-mark';
    siteMark.textContent = mark;
    art.append(siteMark);
    if (settings) {
        const logo = document.createElement('img');
        logo.className = 'tile-settings-artwork';
        logo.alt = '';
        logo.addEventListener('load', () => { siteMark.hidden = true; }, { once: true });
        logo.addEventListener('error', () => logo.remove(), { once: true });
        logo.src = icon;
        art.append(logo);
    }

    const badge = document.createElement('span');
    badge.className = 'tile-badge';
    badge.setAttribute('aria-hidden', 'true');
    const initial = document.createElement('span');
    initial.textContent = mark;
    badge.append(initial);
    if (icon) {
        const image = document.createElement('img');
        image.alt = '';
        image.loading = 'lazy';
        image.addEventListener('load', () => {
            initial.hidden = true;
            image.dataset.loaded = 'true';
        }, { once: true });
        image.src = icon;
        badge.append(image);
    }
    tile.append(art, badge);
    tile.addEventListener('click', () => request('commit', tab.id));
    return tile;
}

let previewRequest = 0;
const previewInvalidations = new WeakMap();

function paintThumbnail(tile, source) {
    const art = tile.querySelector('.tile-art');
    const previous = art.querySelector('.tile-preview');
    if (previous && previous.getAttribute('src') === source) return;
    previous?.remove();
    tile.title = tile.dataset.previewFallback;
    if (typeof source !== 'string' || !source.startsWith('data:image/jpeg;base64,')) return;

    const image = document.createElement('img');
    image.className = 'tile-preview';
    image.alt = '';
    image.addEventListener('load', () => {
        if (!image.isConnected) return;
        image.dataset.loaded = 'true';
        tile.removeAttribute('title');
    }, { once: true });
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = source;
    art.append(image);
}

async function refreshPreviews() {
    if (finished) return;
    const version = ++previewRequest;
    try {
        const result = await chrome.runtime.sendMessage({ type: TAB_SWITCHER_SESSION, action: 'previews' });
        if (!result?.success || finished || version !== previewRequest) return;
        for (const [id, tile] of tiles) {
            if ((previewInvalidations.get(tile) ?? 0) < version) paintThumbnail(tile, result.previews?.[id]);
        }
    } catch {
        // The native favicon and site tile cover an unavailable preview.
    }
}

function clearPreviews(affectedTiles) {
    for (const tile of affectedTiles) {
        previewInvalidations.set(tile, previewRequest);
        paintThumbnail(tile);
    }
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
    const tile = tiles.get(tabId);
    if (tile && (change.status === 'loading' || change.url !== undefined || change.discarded === true)) {
        clearPreviews([tile]);
    }
});
chrome.tabs.onRemoved.addListener(tabId => {
    const tile = tiles.get(tabId);
    if (tile) clearPreviews([tile]);
});

const current = chrome.windows.getCurrent();
let generation = 0;
let themeRequested = false;
async function render(state) {
    const version = ++generation;
    if (!state || state.token !== token || Boolean((await current).incognito) !== state.incognito) return;
    if (version !== generation) return;
    if (!themeRequested) {
        themeRequested = true;
        applyPopupSpaceTheme(state.originWindowId, state.originId);
    }
    const ids = state.tabIds.join(',');
    if (renderedIds !== ids) {
        const openTabs = await chrome.tabs.query({});
        if (version !== generation) return;
        const candidates = new Map(openTabs.filter(tab => Boolean(tab.incognito) === state.incognito)
            .map(tab => [tab.id, tab]));
        tiles = new Map(state.tabIds.filter(id => candidates.has(id)).map(id => [id, tabTile(candidates.get(id))]));
        renderedIds = ids;
        list.style.setProperty('--tab-count', tiles.size || 1);
        list.replaceChildren(...tiles.values());
        list.setAttribute('aria-busy', 'false');
        refreshPreviews();
    }
    markSelection(state);
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[TAB_SWITCHER_PAGE_PREVIEWS]?.newValue === false) clearPreviews(tiles.values());
    if (area !== 'session') return;
    const cache = changes[TAB_SWITCHER_PREVIEW_CACHE];
    if (cache) {
        const removedTiles = [];
        let changed = false;
        for (const [id, tile] of tiles) {
            const before = cache.oldValue?.[id];
            const after = cache.newValue?.[id];
            if (before && !after) removedTiles.push(tile);
            if (after && (before?.expiresAt !== after.expiresAt || before?.data !== after.data)) changed = true;
        }
        if (removedTiles.length) clearPreviews(removedTiles);
        if (changed) refreshPreviews();
    }
    if (changes[TAB_SWITCHER_SESSION]) {
        render(changes[TAB_SWITCHER_SESSION].newValue).catch(() => { status.textContent = 'Could not load open tabs.'; });
    }
});
const initialGeneration = generation;
chrome.storage.session.get(TAB_SWITCHER_SESSION).then(stored => {
    if (generation === initialGeneration) return render(stored[TAB_SWITCHER_SESSION]);
})
    .catch(() => { status.textContent = 'Could not load open tabs.'; });
list.focus();
