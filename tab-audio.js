import { TAB_AUDIO_ICON, TAB_MUTED_ICON } from './icons.js';
import { Logger } from './logger.js';

export function isAudioOnlyTabChange(change) {
    const keys = Object.keys(change);
    return keys.length > 0 && keys.every(key => key === 'audible' || key === 'mutedInfo');
}

// Only events newer than an asynchronous native read may override that read.
// Entries live in this sidebar and are cleared on removal/detach or pruned by
// a full native window snapshot; no audio metadata is persisted.
export class TabAudioEvents {
    constructor() { this.revision = 0; this.latest = new Map(); this.reads = new Set(); this.removed = new Map(); }
    record(tab, windowId) {
        if (tab?.windowId !== windowId || !Number.isInteger(tab?.id) || tab.id < 0) return;
        this.latest.set(tab.id, { revision: ++this.revision, audible: tab.audible, mutedInfo: tab.mutedInfo });
    }
    forget(tabId) {
        this.latest.delete(tabId);
        if (this.reads.size) this.removed.set(tabId, ++this.revision);
    }
    apply(tab, since) {
        if ((this.removed.get(tab?.id) || 0) > since) return null;
        const event = this.latest.get(tab?.id);
        return event && event.revision > since ? { ...tab, audible: event.audible, mutedInfo: event.mutedInfo } : tab;
    }
    reconcileWindow(tabs, since) {
        const ids = new Set(tabs.map(tab => tab.id));
        for (const [id, event] of this.latest) if (!ids.has(id) && event.revision <= since) this.latest.delete(id);
        return tabs.map(tab => this.apply(tab, since)).filter(Boolean);
    }
    async read(operation, fullWindow = false) {
        const since = this.revision;
        const token = { since };
        this.reads.add(token);
        try {
            const result = await operation();
            return fullWindow ? this.reconcileWindow(result, since) : Array.isArray(result) ?
                result.map(tab => this.apply(tab, since)).filter(Boolean) : this.apply(result, since);
        } finally {
            this.reads.delete(token);
            const oldest = Math.min(...[...this.reads].map(read => read.since));
            for (const [id, revision] of this.removed) if (revision <= oldest) this.removed.delete(id);
        }
    }
}

export function tabAudioState(tab) {
    if (!Number.isInteger(tab?.id) || tab.id < 0) return null;
    if (tab.mutedInfo?.muted === true) return 'muted';
    return tab.audible === true ? 'audible' : null;
}

function createAudioButton(element, { id, windowId }, chromeApi, toggleMute) {
    const button = element.ownerDocument.createElement('button');
    button.className = 'tab-audio-indicator';
    button.type = 'button';
    let pending = false;
    let releasedOutside = false;

    // Keep a press on the speaker from turning into a click on the surrounding row.
    button.addEventListener('pointerdown', event => {
        if (event.button !== 0 && event.button !== 1) return;
        releasedOutside = false;
        button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointerup', event => {
        const hit = element.ownerDocument.elementFromPoint(event.clientX, event.clientY);
        releasedOutside = !button.contains(hit);
    });

    // Prevent the draggable row from starting a native drag on this control.
    button.addEventListener('mousedown', event => {
        event.preventDefault();
        if (event.button === 0) button.focus({ preventScroll: true });
    });
    for (const type of ['auxclick', 'dblclick']) {
        button.addEventListener(type, event => {
            event.preventDefault();
            event.stopPropagation();
        });
    }
    button.addEventListener('click', async event => {
        event.stopPropagation();
        if (pending || !button.isConnected || (event.detail > 0 && releasedOutside)) return;
        pending = true;
        try {
            if (toggleMute) {
                await toggleMute(element, id);
                return;
            }
            const current = await chromeApi.tabs.get(id);
            if (!button.isConnected || current.windowId !== windowId || !tabAudioState(current)) return;
            await chromeApi.tabs.update(id, { muted: current.mutedInfo?.muted !== true });
        } catch (error) {
            Logger.warn(Logger.context('Could not change tab mute.'), error);
        } finally {
            pending = false;
        }
    });
    return button;
}

export function updateTabAudioIndicator(element, tab, { live = true, chromeApi = globalThis.chrome, toggleMute } = {}) {
    const state = live ? tabAudioState(tab) : null;
    const favorite = element.classList.contains('pinned-favicon');
    // Native Favorites keep their activation and audio as sibling buttons.
    const host = favorite ? element.closest('.favorite-tile') : element;
    let indicator = host?.querySelector(':scope > .tab-audio-indicator');
    const label = state === 'audible' ? 'Playing audio' : state === 'muted' ? 'Muted' : '';
    if (state && host) {
        if (!indicator) {
            indicator = createAudioButton(element, tab, chromeApi, toggleMute);
            const close = favorite ? null : host.querySelector(':scope > .tab-close, :scope > .tab-remove');
            host.insertBefore(indicator, close);
        }
        const name = element.querySelector('.tab-title-display')?.textContent || tab.title || '';
        const action = state === 'muted' ? 'Unmute tab' : 'Mute tab';
        indicator.dataset.audioState = state;
        indicator.innerHTML = state === 'muted' ? TAB_MUTED_ICON : TAB_AUDIO_ICON;
        indicator.title = action;
        indicator.setAttribute('aria-label', name ? `${action}: ${name}` : action);
        element.dataset.audioState = state;
    } else {
        const restoreFocus = indicator && element.ownerDocument.activeElement === indicator;
        indicator?.remove();
        if (restoreFocus) {
            if (!favorite) element.tabIndex = -1;
            element.focus({ preventScroll: true });
        }
        delete element.dataset.audioState;
    }
    let baseTitle = favorite ? element.dataset.audioBaseTitle || '' : element.title || '';
    const previousLabel = element.dataset.audioLabel;
    if (!favorite && previousLabel && baseTitle.endsWith(`\n${previousLabel}`)) {
        baseTitle = baseTitle.slice(0, -previousLabel.length - 1);
    }
    if (label) element.dataset.audioLabel = label;
    else delete element.dataset.audioLabel;
    if (label && !baseTitle) baseTitle = element.querySelector('.tab-title-display')?.textContent || '';
    element.title = label ? `${baseTitle}\n${label}` : baseTitle;
    if (favorite) element.setAttribute('aria-label', element.title);
}

export function updateWindowTabAudio(document, tab, windowId, toggleFavoriteMute) {
    if (tab?.windowId !== windowId || !Number.isInteger(tab?.id) || tab.id < 0) return;
    for (const element of document.querySelectorAll(`.tab[data-tab-id="${tab.id}"], .pinned-favicon[data-tab-id="${tab.id}"]`)) {
        updateTabAudioIndicator(element, tab, {
            toggleMute: element.classList.contains('pinned-favicon') ? toggleFavoriteMute : undefined
        });
    }
}
