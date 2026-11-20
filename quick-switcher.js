import { applyPopupSpaceTheme } from './space-client.js';
import { searchBrowser, activateBrowserResult, resolveSearchWindow, deleteHistoryResult, historyDestinationIdentity } from './quick-switcher-search.js';
import { numberShortcutIndex, optionDigit } from './quick-switcher-keyboard.js';
import { activateGoogleSearch } from './quick-switcher-google.js';
import { activateTypedWebsite, typedWebsiteUrl } from './quick-switcher-url.js';
import { startRowExitMotion } from './tab-close-motion.js';
import { connectPopupFrame } from './popup-renderer.js';

const input = document.getElementById('search');
const results = document.getElementById('results');
const status = document.getElementById('search-status');
const labels = { tab: 'Open tab', bookmark: 'Bookmark', history: 'History' };
let contextReady, sendInline;
let context, filtered = [], selected = 0, version = 0, timer, activating = false, deleting = false, deleteFeedback = null;
let selectionExplicit = false;
let confirmingHistory = false;
let pointer = { x: -1, y: -1 };
let historyExit, pendingDeletion;

function closePicker() {
    if (sendInline) {
        document.documentElement.removeAttribute('data-picker-ready');
        return sendInline('dismiss');
    }
    window.close();
}

async function requireLivePicker(action) {
    if (sendInline && !(await sendInline(action))?.valid) throw new Error('The search picker no longer owns this page');
}

if (/^mac/i.test(navigator.userAgentData?.platform || navigator.platform)) {
    document.getElementById('digit-entry-keycap').textContent = '⌥0–9';
    document.getElementById('digit-entry-description').textContent = 'Option plus 0 through 9';
}

function icon(name, className = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `icon ${className}`);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.append(use);
    return svg;
}

function highlighted(text) {
    const fragment = document.createDocumentFragment();
    const query = input.value.trim().toLowerCase();
    const index = query ? text.toLowerCase().indexOf(query) : -1;
    if (index < 0) fragment.append(document.createTextNode(text));
    else {
        const mark = document.createElement('mark');
        mark.textContent = text.slice(index, index + query.length);
        fragment.append(document.createTextNode(text.slice(0, index)), mark,
            document.createTextNode(text.slice(index + query.length)));
    }
    return fragment;
}

function ageLabel(age) {
    if (age === null) return '';
    const minutes = Math.floor(age / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours} hr ago` : `${Math.floor(hours / 24)} days ago`;
}

function orderedResults(query, native = []) {
    const text = query.trim();
    if (!text) return native;
    const google = { id: 'google-search', source: 'google', query: text, title: `Search Google for “${text}”` };
    const url = typedWebsiteUrl(text);
    if (!url) return [...native, google];
    return [{ id: 'open-url', source: 'url', query: text, url, title: 'Open in new tab' }, google, ...native];
}

function isSearchAction(item) {
    return item?.source === 'url' || item?.source === 'google';
}

function select(index, scroll = false, explicit = false) {
    selected = index;
    const rows = results.querySelectorAll('.result');
    for (const [i, row] of rows.entries()) {
        row.dataset.selected = String(i === selected);
        row.closest('.result-row').setAttribute('aria-selected', String(i === selected));
    }
    const item = filtered[selected];
    selectionExplicit = Boolean(item && explicit);
    const row = rows[selected];
    if (row) {
        input.setAttribute('aria-activedescendant', row.id);
        if (scroll) row.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
    document.getElementById('action-label').textContent =
        item?.source === 'google' ? 'search Google' : item?.source === 'tab' ? 'switch to tab' :
            item?.source === 'url' ? 'open in new tab' : 'open page';
}

function setStatus(text, error = false) {
    status.textContent = text;
    status.dataset.error = String(error);
}

async function activate(index, newTab = false) {
    const item = filtered[index];
    if (!item || activating || deleting) return;
    const searchingGoogle = item.source === 'google';
    const openingUrl = item.source === 'url';
    if (isSearchAction(item) ? item.query !== input.value.trim() : results.getAttribute('aria-busy') !== 'false') return;
    activating = true;
    ++version;
    clearTimeout(timer);
    input.disabled = true;
    for (const row of results.querySelectorAll('button')) row.disabled = true;
    setStatus(searchingGoogle ? 'Searching Google in a new tab…' : newTab || openingUrl ? 'Opening in a new tab…' :
        item.source === 'tab' ? 'Switching to tab…' : 'Opening page…');
    try {
        context ||= await contextReady;
        if (!context) throw new Error('No browser window');
        await requireLivePicker('activate');
        if (searchingGoogle) await activateGoogleSearch(item.query, context);
        else if (openingUrl) await activateTypedWebsite(item.query, context);
        else await activateBrowserResult(item, context, newTab);
        closePicker();
    } catch {
        if (sendInline) sendInline('resume');
        activating = false;
        input.disabled = false;
        for (const row of results.querySelectorAll('button')) row.disabled = false;
        // A search action may cancel an in-flight native lookup.
        // Restart that lookup after a failed navigation instead of leaving it busy.
        if (results.getAttribute('aria-busy') === 'true') requestSearch(0, true);
        setStatus(searchingGoogle ? 'Could not search Google. Try again.' : 'Could not open this result. Try again.', true);
        input.focus();
    }
}

function clearHistoryExit() {
    historyExit?.motion?.cancel();
    historyExit = undefined;
}

function matchingDeletion(item) {
    const urls = pendingDeletion?.urls;
    return urls && item.source === 'history' && urls.length === item.historyUrls?.length &&
        urls.every(url => item.historyUrls.includes(url));
}

function clearPendingDeletion() {
    pendingDeletion = undefined;
    const highlighted = results.querySelector('[data-confirm-history]');
    if (!highlighted) return;
    highlighted.removeAttribute('data-confirm-history');
    const { item, remove } = renderedRows.get(highlighted);
    remove.hidden = true;
    remove.textContent = '×';
    remove.title = 'Delete from browser history';
    remove.setAttribute('aria-label', `Delete ${item.title} from browser history`);
}

async function requestHistoryConfirmation(item) {
    deleting = true;
    setStatus('Opening the Quick Switcher window to confirm deletion…');
    const response = await sendInline('confirmDelete', { query: input.value, urls: item.historyUrls });
    if (response?.accepted) return;
    deleting = false;
    deleteFeedback = { text: 'Could not open Quick Switcher to confirm deletion. Try again.', error: true };
    requestSearch(0, true);
    input.focus({ preventScroll: true });
}

async function removeHistory(item, wrapper, event) {
    if (!event.isTrusted && (sendInline || confirmingHistory)) return;
    if (activating || deleting || results.getAttribute('aria-busy') !== 'false') return;
    if (sendInline) return requestHistoryConfirmation(item);
    if (confirmingHistory && !matchingDeletion(item)) return;
    const origin = matchingDeletion(item) ? pendingDeletion.source : null;
    clearPendingDeletion();
    deleting = true;
    deleteFeedback = null;
    ++version;
    clearTimeout(timer);
    results.setAttribute('aria-busy', 'true');
    for (const button of results.querySelectorAll('button')) button.disabled = true;
    setStatus('Deleting from browser history…');
    try {
        if (origin) {
            const tab = await chrome.tabs.get(origin.id);
            if (!tab.active || tab.pendingUrl || tab.url !== origin.url || tab.windowId !== context.id || tab.incognito) {
                throw new Error('The originating tab changed before deletion');
            }
        }
        const outcome = await deleteHistoryResult(item, context);
        deleteFeedback = outcome.failed.length ? {
            text: outcome.deleted.length ? 'Some history URLs could not be deleted. Remaining entries are shown; try again.' :
                'Could not delete this result from browser history. Try again.', error: true,
        } : { text: 'Deleted from browser history.', error: false };
        if (!outcome.failed.length && wrapper.isConnected) {
            historyExit = { row: wrapper, destination: historyDestinationIdentity(item.url) };
        }
    } catch {
        deleteFeedback = { text: 'Could not delete this result from browser history. Try again.', error: true };
    } finally {
        deleting = false;
        for (const action of results.querySelectorAll('[data-search-action]')) action.disabled = false;
        // Coalesce native removal events and edits into one fresh current-query lookup.
        requestSearch(0, true);
        input.focus();
    }
}

const renderedRows = new WeakMap();

function createResultRow(item) {
    const wrapper = document.createElement('div');
    wrapper.className = 'result-row';
    wrapper.setAttribute('role', 'row');
    const destination = document.createElement('div');
    destination.className = 'result-destination';
    destination.setAttribute('role', 'gridcell');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'result';
    row.id = `result-${item.id}`;
    row.dataset.source = item.source;
    const favicon = document.createElement('span');
    favicon.className = 'result-icon';
    const copy = document.createElement('span');
    copy.className = 'result-copy';
    const title = document.createElement('span');
    title.className = 'result-title';
    copy.append(title);
    row.append(favicon, copy);

    if (isSearchAction(item)) {
        row.dataset.searchAction = '';
        favicon.append(icon(item.source === 'google' ? 'search' : 'tab'));
    } else {
        row.dataset.url = item.url;
        const image = document.createElement('img');
        image.alt = '';
        const localIcon = new URL(chrome.runtime.getURL('/_favicon/'));
        localIcon.searchParams.set('pageUrl', item.url);
        localIcon.searchParams.set('size', '32');
        image.src = localIcon.href;
        image.addEventListener('error', () => favicon.replaceChildren(icon(item.source)), { once: true });
        favicon.append(image);
        const openTab = item.source === 'tab';
        if (openTab) row.setAttribute('aria-description', labels.tab);
        if (!openTab || item.bookmarked) {
            const badge = document.createElement('span');
            badge.className = 'source';
            if (openTab) {
                const saved = icon('bookmark');
                saved.setAttribute('role', 'img');
                saved.setAttribute('aria-label', 'Also bookmarked');
                saved.removeAttribute('aria-hidden');
                badge.append(saved);
            } else {
                badge.append(icon(item.source), document.createTextNode(labels[item.source]));
            }
            row.append(badge);
        }
    }
    const meta = document.createElement('span');
    meta.className = 'result-meta';
    if (item.source !== 'google') copy.append(meta);
    const shortcut = document.createElement('span');
    shortcut.className = 'result-shortcut';
    shortcut.setAttribute('aria-hidden', 'true');
    shortcut.append(icon('return', 'return-icon'));
    row.append(shortcut);
    const view = { row, title, meta, shortcut, item };
    renderedRows.set(wrapper, view);
    row.addEventListener('focus', () => select(view.index, false, true));
    row.addEventListener('click', event => {
        if (wrapper.parentElement === results) activate(view.index, event.metaKey || event.ctrlKey);
    });
    destination.append(row);
    wrapper.append(destination);
    if (item.source === 'history' && item.historyUrls?.length && !context.incognito) {
        wrapper.classList.add('has-history-delete');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'history-delete';
        remove.textContent = '×';
        remove.title = 'Delete from browser history';
        remove.addEventListener('focus', () => select(view.index));
        remove.addEventListener('click', event => {
            event.stopPropagation();
            if (wrapper.parentElement === results) removeHistory(view.item, wrapper, event);
        });
        remove.addEventListener('keydown', event => {
            if (event.repeat || event.isComposing || event.keyCode === 229 ||
                event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) {
                if (event.key === 'Enter' || event.key === ' ') event.preventDefault();
            }
        });
        const action = document.createElement('div');
        action.className = 'history-delete-cell';
        action.setAttribute('role', 'gridcell');
        action.append(remove);
        wrapper.append(action);
        view.remove = remove;
    }
    return wrapper;
}

function updateResultRow(view, item, index, query) {
    const { row, title, meta, shortcut, remove } = view;
    view.item = item;
    row.disabled = deleting;
    if (remove) {
        remove.hidden = confirmingHistory && !matchingDeletion(item);
        remove.disabled = deleting;
        remove.setAttribute('aria-label', `Delete ${item.title} from browser history`);
    }

    if (view.index !== index) {
        shortcut.querySelector('.shortcut-number')?.remove();
        row.removeAttribute('aria-keyshortcuts');
        if (index > 0 && index <= 9) {
            row.setAttribute('aria-keyshortcuts', String(index));
            const number = document.createElement('span');
            number.className = 'shortcut-number';
            number.textContent = String(index);
            shortcut.append(number);
        }
        view.index = index;
    }

    if (item.source === 'google') {
        row.title = item.title;
        row.setAttribute('aria-label', `${item.title}, opens a new tab`);
        if (title.textContent !== item.title) title.textContent = item.title;
        return;
    }
    row.title = item.displayUrl || item.url;
    if (item.source === 'url') row.setAttribute('aria-label', `Open ${item.url} in a new tab`);
    const url = new URL(item.url);
    const domain = url.hostname || (url.protocol === 'file:' ? 'Local file' : item.url);
    const details = item.source === 'url' ? item.url : [
        domain, item.detail, item.context, item.source === 'history' ? ageLabel(item.age) : '',
    ].filter(Boolean).join(' · ');
    if (view.query !== query || view.titleText !== item.title) title.replaceChildren(highlighted(item.title));
    if (view.query !== query || view.detailsText !== details) meta.replaceChildren(highlighted(details));
    view.query = query;
    view.titleText = item.title;
    view.detailsText = details;
}

function renderRows(items) {
    const existing = new Map([...results.children].map(row => [renderedRows.get(row).item.id, row]));
    const query = input.value.trim();
    filtered = items;
    const next = new Set();
    for (const [index, item] of items.entries()) {
        let row = existing.get(item.id);
        const previous = renderedRows.get(row)?.item;
        if (!previous || (!isSearchAction(item) && (previous.url !== item.url ||
            previous.bookmarked !== item.bookmarked || Boolean(previous.historyUrls?.length) !== Boolean(item.historyUrls?.length)))) {
            row = createResultRow(item);
        }
        updateResultRow(renderedRows.get(row), item, index, query);
        next.add(row);
    }
    for (const row of existing.values()) {
        if (!next.has(row)) row.remove();
    }
    let current = results.firstElementChild;
    for (const row of next) {
        if (row === current) current = current.nextElementSibling;
        else results.insertBefore(row, current);
    }
}

function updateResultCount(announce = true) {
    const count = `${filtered.length} ${filtered.length === 1 ? 'result' : 'results'}`;
    document.getElementById('results-count').textContent = count;
    if (announce) document.getElementById('announcement').textContent = count;
}

function render(response, query, preserveSelection) {
    // An automatic Google selection yields to native matches on refresh.
    const previous = filtered[selected];
    const explicit = selectionExplicit;
    const keepSelection = explicit || (preserveSelection && previous?.source !== 'google');
    const items = orderedResults(query, response.results);
    const firstLocalIndex = items[0]?.source === 'url' ? 2 : 0;
    const lastLocalIndex = response.results.length ? firstLocalIndex + response.results.length - 1 : 0;
    const fallback = preserveSelection ? Math.max(0, Math.min(selected, lastLocalIndex)) : 0;
    const actionFocused = document.activeElement?.hasAttribute('data-search-action');
    renderRows(items);
    results.removeAttribute('data-typing');
    results.setAttribute('aria-busy', 'false');
    document.getElementById('empty').hidden = filtered.length > 0;
    document.querySelector('#empty > span').textContent = response.unavailable.length === 3 ? 'Search unavailable' : 'No matches found';
    updateResultCount();
    setStatus(response.unavailable.length ? `${response.unavailable.join(' and ')} unavailable` :
        context.incognito ? 'Incognito' : '', response.unavailable.length > 0);
    if (deleteFeedback) setStatus(deleteFeedback.text, deleteFeedback.error);
    const index = keepSelection ? filtered.findIndex(item => item.id === previous?.id) : -1;
    select(filtered.length ? (index >= 0 ? index : fallback) : -1, index >= 0, explicit && index >= 0);
    if (pendingDeletion) {
        const target = items.findIndex(matchingDeletion);
        if (target < 0) {
            clearPendingDeletion();
            setStatus('The history result changed. Review the current results before deleting.', true);
        } else {
            const row = results.children[target];
            const { item, remove } = renderedRows.get(row);
            const first = !row.hasAttribute('data-confirm-history');
            row.setAttribute('data-confirm-history', '');
            remove.textContent = 'Delete';
            remove.title = 'Confirm deletion from browser history';
            remove.setAttribute('aria-label', `Confirm deletion of ${item.title} from browser history`);
            setStatus('Confirm deletion from browser history.');
            if (first) select(target, true, true);
        }
    }
    if (actionFocused) input.focus({ preventScroll: true });
}

function retainMatchingRows(query) {
    if (deleting) return [];
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const exiting = historyExit && renderedRows.get(historyExit.row).item.id;
    return filtered.filter(item => {
        if (isSearchAction(item) || item.id === exiting) return false;
        const searchable = `${item.title} ${item.url}`.toLowerCase();
        return terms.every(term => searchable.includes(term));
    });
}

function requestSearch(delay = 120, preserveSelection = false) {
    if (activating) return;
    const request = ++version;
    const query = input.value;
    clearTimeout(timer);
    const started = results.hasAttribute('aria-busy');
    results.setAttribute('aria-busy', 'true');
    if (!preserveSelection) {
        const retained = retainMatchingRows(query);
        clearHistoryExit();
        renderRows(orderedResults(query, retained));
        if (started) results.setAttribute('data-typing', '');
        // Only the URL action can activate by default before Chrome answers.
        select(retained.length || filtered[0]?.source === 'url' ? 0 : -1);
        document.getElementById('empty').hidden = true;
        document.getElementById('results-label').textContent = query.trim() ? 'Results' : 'Jump back in';
        if (started) updateResultCount(false);
    }
    const preserveNativeSelection = preserveSelection && !results.hasAttribute('data-typing');
    if (deleting) { setStatus('Deleting from browser history…'); return; }
    timer = setTimeout(async () => {
        try {
            context = await contextReady;
            if (!context) throw new Error('No browser window');
            const response = await searchBrowser(query, context);
            if (request !== version || activating) return;
            // A refreshed group can still contain a variant beyond the previous lookup's limit.
            if (historyExit && !response.unavailable.includes('History') &&
                !response.results.some(item => historyDestinationIdentity(item.url) === historyExit.destination)) {
                historyExit.motion ??= startRowExitMotion(historyExit.row, 'result-exiting');
                if (historyExit.motion) await historyExit.motion.finished;
                // A native event may schedule a fresher lookup during the exit.
                if (request !== version || activating) return;
            }
            render(response, query, preserveNativeSelection);
            clearHistoryExit();
        } catch {
            if (request !== version || activating) return;
            if (historyExit || results.hasAttribute('data-typing')) {
                // The retained rows were either removed or could not be confirmed.
                const previous = filtered[selected];
                renderRows(orderedResults(query));
                const index = selectionExplicit ? filtered.findIndex(item => item.id === previous?.id) : -1;
                select(index >= 0 ? index : filtered[0]?.source === 'url' ? 0 : -1);
                updateResultCount();
            }
            clearHistoryExit();
            results.removeAttribute('data-typing');
            results.setAttribute('aria-busy', 'false');
            setStatus(deleteFeedback?.error ? `${deleteFeedback.text} Could not refresh results. Reopen the palette.` : 'Could not search Chrome. Reopen the palette to try again.', true);
        }
    }, delay);
}

function startPicker(windowId, inlineClient, incognito = false, deletion) {
    sendInline = inlineClient;
    const exact = Boolean(inlineClient || deletion);
    contextReady = resolveSearchWindow(windowId, chrome, exact).then(window => {
        if (Boolean(window.incognito) !== incognito) return null;
        return exact ? { id: window.id, incognito: false, exact: true } : window;
    }).catch(() => null);
    contextReady.then(source => { if (source) applyPopupSpaceTheme(source.id); });
    if (inlineClient) document.documentElement.setAttribute('data-inline-search', '');
    document.documentElement.setAttribute('data-picker-ready', '');

    if (deletion) {
        confirmingHistory = true;
        pendingDeletion = deletion;
        input.value = deletion.query;
        setStatus('Finding the history result to confirm deletion…');
    }
    input.addEventListener('input', () => { clearPendingDeletion(); deleteFeedback = null; requestSearch(); });
    input.addEventListener('keydown', event => {
        const digit = optionDigit(event);
        if (digit === null) return;
        event.preventDefault();
        // Use Chromium's text editing command to preserve selection, maxlength, and undo.
        document.execCommand('insertText', false, digit);
    });
    document.getElementById('close').addEventListener('click', closePicker);
    document.addEventListener('pointermove', event => {
        if (event.clientX === pointer.x && event.clientY === pointer.y) return;
        pointer = { x: event.clientX, y: event.clientY };
        const row = event.target.closest('.result-row');
        if (row && !activating && !deleting) select([...results.children].indexOf(row), false, true);
    });
    document.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (pendingDeletion && event.target === input) {
            if (event.key === 'Enter') { event.preventDefault(); return; }
            const confirm = results.querySelector('[data-confirm-history] .history-delete');
            if (confirm && event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                confirm.focus();
                return;
            }
        }
        if (event.target.closest?.('.history-delete')) {
            if (event.key === 'Escape') { event.preventDefault(); closePicker(); return; }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            input.focus();
        }
        const shortcutIndex = numberShortcutIndex(event, filtered.length);
        if (shortcutIndex !== null) {
            event.preventDefault();
            // Retained rows may belong to an older response while native sources refresh.
            const websiteAction = filtered[0]?.source === 'url' && isSearchAction(filtered[shortcutIndex]);
            if (!event.repeat && (websiteAction || results.getAttribute('aria-busy') === 'false')) activate(shortcutIndex);
        } else if (event.key === 'Escape') { event.preventDefault(); closePicker(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const count = filtered.length;
            if (count && !activating && !deleting) {
                const down = event.key === 'ArrowDown';
                const next = selected < 0 ? (down ? 0 : count - 1) : (selected + (down ? 1 : -1) + count) % count;
                select(next, true, true);
            }
        } else if (event.key === 'Enter' && event.target !== document.getElementById('close')) {
            event.preventDefault();
            if (!event.repeat && !event.altKey && !event.shiftKey) activate(selected, event.metaKey || event.ctrlKey);
        }
    });
    const refresh = () => { if (!deleting) requestSearch(160, true); };
    for (const event of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated,
        chrome.bookmarks.onCreated, chrome.bookmarks.onRemoved, chrome.bookmarks.onChanged,
        chrome.bookmarks.onMoved, chrome.history?.onVisited, chrome.history?.onVisitRemoved]) event?.addListener(refresh);
    function focusInput() {
        if (activating) return;
        input.focus({ preventScroll: true });
        if (inlineClient && document.hasFocus() && document.activeElement === input) inlineClient('focused');
    }
    window.addEventListener('focus', focusInput);
    if (inlineClient) {
        document.addEventListener('pointerdown', event => {
            if (event.isTrusted && !event.target.closest('.palette')) closePicker();
        });
        contextReady.then(source => { if (source) inlineClient('interactive'); });
    } else focusInput();
    requestSearch(0);
}

if (window.parent === window) {
    chrome.runtime.sendMessage({ type: 'quickSwitcherWindow' }).then(({ windowId, incognito, deletion }) => {
        if (Number.isInteger(windowId) && windowId >= 0) startPicker(windowId, undefined, incognito, deletion);
    }).catch(() => {});
} else {
    connectPopupFrame(({ windowId }, send) => {
        if (Number.isInteger(windowId) && windowId >= 0) startPicker(windowId, send);
    });
}
