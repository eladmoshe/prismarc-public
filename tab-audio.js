import { TAB_AUDIO_ICON, TAB_MUTED_ICON } from './icons.js';

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

// Native metadata only: this indicator neither controls nor captures audio.
export function updateTabAudioIndicator(element, tab, { live = true } = {}) {
    const state = live ? tabAudioState(tab) : null;
    let indicator = element.querySelector(':scope > .tab-audio-indicator');
    const label = state === 'audible' ? 'Playing audio' : state === 'muted' ? 'Muted' : '';
    if (state) {
        if (!indicator) {
            indicator = element.ownerDocument.createElement('span');
            indicator.className = 'tab-audio-indicator';
            indicator.setAttribute('role', 'img');
            element.append(indicator);
        }
        indicator.dataset.audioState = state;
        indicator.innerHTML = state === 'muted' ? TAB_MUTED_ICON : TAB_AUDIO_ICON;
        indicator.setAttribute('aria-label', label);
        element.dataset.audioState = state;
    } else {
        indicator?.remove();
        delete element.dataset.audioState;
    }
    const favorite = element.classList.contains('pinned-favicon');
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

export function updateWindowTabAudio(document, tab, windowId) {
    if (tab?.windowId !== windowId || !Number.isInteger(tab?.id) || tab.id < 0) return;
    for (const element of document.querySelectorAll(`.tab[data-tab-id="${tab.id}"], .pinned-favicon[data-tab-id="${tab.id}"]`)) {
        updateTabAudioIndicator(element, tab);
    }
}
