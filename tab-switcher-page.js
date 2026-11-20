import { watchAppearance } from './space-client.js';
import { TAB_SWITCHER_SESSION } from './tab-switcher.js';
import { describeOpenTab, usesOptionShortcut } from './tab-switcher-tabs.js';
import { TAB_SWITCHER_CAPTURE_ON_VISIT, TAB_SWITCHER_EXCLUDED_DOMAINS,
    TAB_SWITCHER_PAGE_PREVIEWS, TAB_SWITCHER_PREVIEW_CACHE } from './tab-switcher-previews.js';
import { isBrowsingPreviewCandidate, shouldOfferVisitPreviewHint, TAB_PREVIEW_HINT_DISMISSED,
    TAB_PREVIEW_HINT_PREFS } from './tab-switcher-preview-settings.js';
import { Utils } from './utils.js';
import { connectPopupFrame, validPopupToken } from './popup-renderer.js';
import { recentTabsLayout, recentTabsPopupAdjustment } from './tab-switcher-layout.js';

const inline = window.parent !== window;
if (inline) {
    // An independently embedded copy stays inert. Its parent never receives picker data.
    connectPopupFrame(({ token }) => {
        document.documentElement.dataset.pickerReady = '';
        startPicker(token, true);
    });
} else if (validPopupToken(location.hash.slice(1))) {
    document.documentElement.dataset.pickerReady = '';
    startPicker(location.hash.slice(1), false);
}

function startPicker(token, inline) {
    const list = document.getElementById('tabs');
    const status = document.getElementById('switcher-status');
    const previewHint = document.getElementById('preview-hint');
    const previewSettings = document.getElementById('preview-settings');
    const previewDismiss = document.getElementById('preview-dismiss');
    const previewHintKeys = [...TAB_PREVIEW_HINT_PREFS, TAB_SWITCHER_EXCLUDED_DOMAINS];
    let tiles = new Map();
    let previewCandidates = new Map();
    let previewHintPreferences;
    let previewHintRevision = 0;
    let hasPreviewResponse = false;
    let renderedIds;
    let finished = false;
    const root = document.documentElement;
    if (/^mac/i.test(navigator.userAgentData?.platform || navigator.platform)) {
        chrome.commands.getAll().then(commands => {
            if (!usesOptionShortcut(commands)) return;
            const key = document.getElementById('switch-key');
            key.textContent = '⌥';
            key.setAttribute('aria-label', 'Option');
            document.getElementById('switch-key-label').textContent = 'Release to switch';
        }).catch(() => {});
    }

    function request(action, tabId) {
        if (finished) return;
        const openingSettings = action === 'previewSettings';
        const ending = action === 'commit' || action === 'cancel' || openingSettings;
        if (ending) finished = true;
        if (openingSettings) document.documentElement.setAttribute('data-opening-preview-settings', '');
        chrome.runtime.sendMessage({ type: TAB_SWITCHER_SESSION, action, tabId }).then(response => {
            if (!response?.success) throw new Error('Could not switch tabs');
        }).catch(() => {
            finished = false;
            if (openingSettings) document.documentElement.removeAttribute('data-opening-preview-settings');
            status.textContent = openingSettings ? 'Could not open preview settings.' : 'Could not switch tabs.';
        });
    }

    function updatePreviewHint() {
        const settings = previewHintPreferences;
        const eligible = hasPreviewResponse && settings && shouldOfferVisitPreviewHint(settings) &&
            [...previewCandidates].some(([id, tab]) =>
                isBrowsingPreviewCandidate(tab, settings[TAB_SWITCHER_EXCLUDED_DOMAINS] ?? []) &&
                !tiles.get(id)?.querySelector('.tile-preview'));
        const restoreFocus = !eligible && previewHint.contains(document.activeElement);
        if (inline && previewHint.hidden === Boolean(eligible)) {
            chrome.runtime.sendMessage({ type: TAB_SWITCHER_SESSION, action: 'inlinePreviewHint', visible: Boolean(eligible) })
                .catch(() => {});
        }
        previewHint.hidden = !eligible;
        if (restoreFocus) list.focus({ preventScroll: true });
    }

    async function refreshPreviewHintPreferences() {
        const version = ++previewHintRevision;
        const settings = await chrome.storage.local.get(previewHintKeys);
        if (version !== previewHintRevision) return;
        previewHintPreferences = settings;
        updatePreviewHint();
    }

    previewSettings.addEventListener('click', event => {
        if (event.isTrusted && !previewHint.hidden) request('previewSettings');
    });

    async function dismissPreviewHint() {
        if (finished || previewHint.hidden) return;
        try {
            await chrome.storage.local.set({ [TAB_PREVIEW_HINT_DISMISSED]: true });
        } catch {
            status.textContent = 'Could not dismiss the preview hint.';
        }
    }

    previewDismiss.addEventListener('click', event => {
        if (event.isTrusted) dismissPreviewHint();
    });

    window.addEventListener('keydown', event => {
        if (event.isComposing || event.ctrlKey || event.metaKey) return;
        if (event.altKey && event.key === 'Tab') {
            event.preventDefault();
            if (!inline || event.shiftKey) request(event.shiftKey ? 'previous' : 'next');
        } else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            request(event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 'next' : 'previous');
        } else if (event.key === 'Enter' || event.key === 'Escape') {
            if (event.key === 'Enter' && previewHint.contains(event.target)) return;
            event.preventDefault();
            request(event.key === 'Enter' ? 'commit' : 'cancel');
        } else if (!previewHint.hidden && event.isTrusted && !event.repeat && (event.code === 'KeyP' || event.code === 'KeyX')) {
            event.preventDefault();
            if (event.code === 'KeyP') request('previewSettings');
            else dismissPreviewHint();
        }
    });
    window.addEventListener('focus', () => list.focus({ preventScroll: true }));

    function keepSelectedVisible(selected) {
        if (!selected || list.scrollHeight <= list.clientHeight) return;
        const top = selected.offsetTop;
        const bottom = top + selected.offsetHeight;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }

    function sizePicker() {
        const layout = recentTabsLayout(tiles.size, window.innerWidth, window.innerHeight);
        root.dataset.pickerLayout = layout.mode;
        root.style.setProperty('--panel-width', `${layout.width}px`);
        if (layout.mode === 'list') root.style.setProperty('--row-height', `${layout.rowHeight}px`);
        root.toggleAttribute('data-picker-tight', layout.mode === 'list' && layout.rowHeight < 38);
        list.setAttribute('aria-orientation', layout.mode === 'list' ? 'vertical' : 'horizontal');
        keepSelectedVisible(list.querySelector('[aria-selected="true"]'));
    }

    function markSelection(state) {
        const selected = tiles.get(state.selectedId);
        for (const [id, tile] of tiles) {
            const active = id === state.selectedId;
            tile.dataset.selected = String(active);
            tile.setAttribute('aria-selected', String(active));
        }
        if (selected) list.setAttribute('aria-activedescendant', selected.id);
        else list.removeAttribute('aria-activedescendant');
        keepSelectedVisible(selected);
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
            hue, mark, icon, host,
            fallbackIcon: settings || tab.favIconUrl ? icon : undefined,
            fallback: web ? 'No recent preview for this tab' : 'Page preview unavailable',
        };
    }

    function tabTile(tab) {
        const label = describeOpenTab(tab);
        const { hue, mark, icon, host, fallback, fallbackIcon } = siteAppearance(tab, label);
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
        if (fallbackIcon) {
            const logo = document.createElement('img');
            logo.className = 'tile-fallback-icon';
            logo.alt = '';
            logo.addEventListener('load', () => { siteMark.hidden = true; }, { once: true });
            logo.addEventListener('error', () => logo.remove(), { once: true });
            logo.src = fallbackIcon;
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
        const caption = document.createElement('span');
        caption.className = 'tile-caption';
        caption.setAttribute('aria-hidden', 'true');
        const copy = document.createElement('span');
        copy.className = 'tile-copy';
        const title = document.createElement('span');
        title.className = 'tile-title';
        title.textContent = label.title;
        const domain = document.createElement('span');
        domain.className = 'tile-domain';
        domain.textContent = host;
        copy.append(title, domain);
        caption.append(badge, copy);
        tile.append(art, caption);
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
        image.addEventListener('error', () => {
            image.remove();
            updatePreviewHint();
        }, { once: true });
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
            hasPreviewResponse = true;
            updatePreviewHint();
        } catch {
            // The native favicon and site tile cover an unavailable preview.
        }
    }

    function clearPreviews(affectedTiles) {
        for (const tile of affectedTiles) {
            previewInvalidations.set(tile, previewRequest);
            paintThumbnail(tile);
        }
        updatePreviewHint();
    }

    chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
        const tile = tiles.get(tabId);
        if (!tile) return;
        previewCandidates.set(tabId, { ...tab, ...change });
        if (change.status === 'loading' || change.status === 'unloaded' || change.url !== undefined || change.discarded === true) {
            clearPreviews([tile]);
        } else {
            updatePreviewHint();
        }
    });
    chrome.permissions.onRemoved.addListener(({ permissions, origins }) => {
        if (permissions?.includes('activeTab') || origins?.length) clearPreviews(tiles.values());
    });
    function forgetPreviewCandidate(tabId) {
        const tile = tiles.get(tabId);
        previewCandidates.delete(tabId);
        if (tile) clearPreviews([tile]);
    }
    chrome.tabs.onRemoved.addListener(forgetPreviewCandidate);
    chrome.tabs.onReplaced?.addListener((_added, removed) => forgetPreviewCandidate(removed));

    const current = chrome.windows.getCurrent();
    let generation = 0;
    let themeRequested = false;

    async function fitNativePopup(state, popup) {
        const tab = await chrome.tabs.getCurrent();
        if (tab?.windowId !== popup.id || ![tab.url, tab.pendingUrl].includes(location.href)) return;
        const [origin, zoom, active, stored] = await Promise.all([
            chrome.windows.get(state.originWindowId).catch(() => null),
            chrome.tabs.getZoom(tab.id),
            chrome.tabs.get(tab.id),
            chrome.storage.session.get(TAB_SWITCHER_SESSION),
        ]);
        const session = stored[TAB_SWITCHER_SESSION];
        if (finished || session?.token !== token || session.surface || !active.active ||
            active.windowId !== popup.id || (active.pendingUrl ?? active.url) !== location.href) return;
        const bounds = recentTabsPopupAdjustment(session.tabIds.length, origin, popup,
            { width: window.innerWidth, height: window.innerHeight }, window.screen, zoom);
        if (bounds) await chrome.windows.update(popup.id, bounds);
    }

    async function render(state) {
        const version = ++generation;
        if (!state || state.token !== token || (inline && state.surface !== 'overlay')) {
            if (inline) {
                finished = true;
                document.documentElement.removeAttribute('data-picker-ready');
                list.replaceChildren();
                tiles.clear();
            }
            return;
        }
        const pickerWindow = await current;
        if (Boolean(pickerWindow.incognito) !== state.incognito) return;
        if (version !== generation) return;
        if (!themeRequested) {
            themeRequested = true;
            watchAppearance(state.originWindowId, state.originId);
            if (!state.incognito) refreshPreviewHintPreferences().catch(() => {});
            // The native window can be smaller than requested or have been
            // opened by the previous worker while the updated page loads.
            if (!inline && !state.surface && pickerWindow.type === 'popup') {
                fitNativePopup(state, pickerWindow).catch(() => {});
            }
        }
        const ids = state.tabIds.join(',');
        if (renderedIds !== ids) {
            const openTabs = await chrome.tabs.query({});
            if (version !== generation) return;
            const candidates = new Map(openTabs.filter(tab => Boolean(tab.incognito) === state.incognito)
                .map(tab => [tab.id, tab]));
            previewCandidates = new Map(state.tabIds.filter(id => candidates.has(id)).map(id => [id, candidates.get(id)]));
            tiles = new Map([...previewCandidates].map(([id, tab]) => [id, tabTile(tab)]));
            renderedIds = ids;
            list.style.setProperty('--tab-count', tiles.size || 1);
            list.replaceChildren(...tiles.values());
            sizePicker();
            list.setAttribute('aria-busy', 'false');
            hasPreviewResponse = false;
            updatePreviewHint();
            refreshPreviews();
        }
        markSelection(state);
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && previewHintKeys.some(key => changes[key])) {
            if (previewHintPreferences) {
                for (const key of previewHintKeys) {
                    if (changes[key]) previewHintPreferences[key] = changes[key].newValue;
                }
                updatePreviewHint();
            } else if (themeRequested) {
                refreshPreviewHintPreferences().catch(() => {});
            }
        }
        if (area === 'local' && (changes[TAB_SWITCHER_PAGE_PREVIEWS]?.newValue === false ||
            changes[TAB_SWITCHER_CAPTURE_ON_VISIT]?.newValue === false || changes[TAB_SWITCHER_EXCLUDED_DOMAINS])) {
            clearPreviews(tiles.values());
        }
        if (area !== 'session') return;
        const cache = changes[TAB_SWITCHER_PREVIEW_CACHE];
        if (cache) {
            const removedTiles = [];
            let changed = false;
            for (const [id, tile] of tiles) {
                const before = cache.oldValue?.[id];
                const after = cache.newValue?.[id];
                if (before && !after) removedTiles.push(tile);
                if (after && before?.ref !== after.ref) changed = true;
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
    window.addEventListener('resize', sizePicker);
    if (inline) {
        window.addEventListener('keyup', event => {
            if (event.isTrusted && (event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight') &&
                !event.altKey) request('commit');
        }, true);
        const outside = event => {
            if (event.isTrusted && !event.target.closest('.switcher')) request('cancel');
        };
        document.addEventListener('pointerdown', outside);
        document.documentElement.setAttribute('data-inline-picker', '');
    }
    if (!inline) list.focus();
}
