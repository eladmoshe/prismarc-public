import { Logger } from './logger.js';

export const MAX_FAVORITES = 12;
const SNAPSHOT_KEY = 'nativeFavoriteSnapshot';
const SESSION_KEY = 'nativeFavoritesSession';
const tabUrl = tab => tab.pendingUrl || tab.url || '';

// One service-worker writer keeps concurrent panels from losing saved URLs or
// exceeding the limit. Native pins made outside Arcify are never removed/hidden.
export class NativeFavorites {
    constructor() {
        this.chain = Promise.resolve();
        this.records = new Map();
        this.restoreQueue = [];
    }

    run(operation) {
        const pending = this.chain.then(async () => {
            if (!this.initialized) await this.initialize();
            return operation();
        });
        this.chain = pending.catch(() => {});
        return pending;
    }

    async initialize() {
        const { [SNAPSHOT_KEY]: snapshot = [] } = await chrome.storage.local.get(SNAPSHOT_KEY);
        const { [SESSION_KEY]: sameSession } = await chrome.storage.session.get(SESSION_KEY);
        const tabs = await chrome.tabs.query({ pinned: true });
        const liveIds = new Set(tabs.map(tab => tab.id));
        if (sameSession) {
            this.records = new Map(snapshot.filter(record => liveIds.has(record.tabId)).map(record => [record.tabId, record]));
            this.restoreQueue = sameSession.restoreQueue || [];
        } else this.restoreQueue = snapshot;
        for (const tab of tabs) this.track(tab);
        this.initialized = true;
        await this.persist();
    }

    track(tab, restore = true) {
        if (!tab.pinned) { this.records.delete(tab.id); return; }
        const url = tabUrl(tab);
        if (!url) return; // A restored tab can be created before it has a URL.
        let record = this.records.get(tab.id);
        if (!record && restore) {
            const index = this.restoreQueue.findIndex(saved => saved.url === url);
            if (index >= 0) record = this.restoreQueue.splice(index, 1)[0];
        }
        this.records.set(tab.id, { tabId: tab.id, url, baseUrl: record?.baseUrl || url,
            title: record?.title || tab.title || url });
    }

    async persist() {
        await chrome.storage.local.set({ [SNAPSHOT_KEY]: [...this.records.values(), ...this.restoreQueue] });
        await chrome.storage.session.set({ [SESSION_KEY]: { restoreQueue: this.restoreQueue } });
    }

    dispatch(message) {
        return this.run(async () => {
            if (message.action === 'pin') {
                if (!Array.isArray(message.tabIds) || !message.tabIds.length ||
                    !message.tabIds.every(id => Number.isInteger(id) && id > 0)) throw new Error('Choose tabs to add to Favorites.');
                const selected = await Promise.all([...new Set(message.tabIds)].map(id => chrome.tabs.get(id)));
                const pinned = await chrome.tabs.query({ pinned: true });
                for (const windowId of new Set(selected.map(tab => tab.windowId))) {
                    const additions = selected.filter(tab => tab.windowId === windowId && !tab.pinned).length;
                    if (additions && pinned.filter(tab => tab.windowId === windowId).length + additions > MAX_FAVORITES) {
                        throw new Error(`Favorites is full. You can add up to ${MAX_FAVORITES} per window. Drag a favorite back into a space to make room.`);
                    }
                }
                for (const tab of selected) {
                    // Capture before pinning/navigation events; reordering never changes it.
                    await chrome.tabs.update(tab.id, { pinned: true });
                    this.track({ ...tab, pinned: true }, tab.pinned);
                }
            } else if (message.action === 'reset') {
                const tab = await chrome.tabs.get(message.tabId);
                if (!tab.pinned) throw new Error('This tab is no longer a Favorite.');
                this.track(tab);
                const baseUrl = this.records.get(tab.id)?.baseUrl;
                if (baseUrl) await chrome.tabs.update(tab.id, { url: baseUrl, active: true });
            } else if (message.action !== 'get') {
                throw new Error('Unknown Favorites action.');
            }
            const tabs = await chrome.tabs.query({ pinned: true, ...(Number.isInteger(message.windowId) ? { windowId: message.windowId } : {}) });
            for (const tab of tabs) this.track(tab);
            await this.persist();
            return tabs.sort((a, b) => a.index - b.index).map(tab => ({ ...tab, ...this.records.get(tab.id) }));
        });
    }

    install() {
        const handle = operation => this.run(async () => { await operation(); await this.persist(); }).catch(Logger.error);
        chrome.tabs.onCreated.addListener(tab => handle(() => this.track(tab)));
        chrome.tabs.onUpdated.addListener((_id, change, tab) => {
            if (change.url || change.pinned !== undefined) handle(() => this.track(tab, change.pinned !== true));
        });
        chrome.tabs.onRemoved.addListener((id, info) => handle(() => {
            const record = this.records.get(id);
            if (info?.isWindowClosing && record) this.restoreQueue.push(record);
            this.records.delete(id);
        }));
        chrome.tabs.onReplaced.addListener((added, removed) => handle(async () => {
            const record = this.records.get(removed);
            if (record) this.records.set(added, { ...record, tabId: added });
            this.records.delete(removed);
            this.track(await chrome.tabs.get(added));
        }));
        this.run(() => {}).catch(Logger.error);
    }
}

export async function favoriteRequest(action, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'nativeFavorites', action, ...payload });
    if (!response?.success) throw new Error(response?.error || 'Favorites unavailable.');
    return response.tabs;
}

// Choose the nearest row first, then the nearest button in that row. An X-only
// search cannot distinguish matching columns in a multi-row grid.
export function getFavoriteDropTarget(container, x, y) {
    const elements = [...container.querySelectorAll('.pinned-favicon:not(.dragging)')];
    if (!elements.length) return container.querySelector('.pinned-placeholder-container');
    const distance = (position, start, end) => Math.max(start - position, position - end, 0);
    return elements.reduce((best, element) => {
        const rect = element.getBoundingClientRect();
        const dy = distance(y, rect.top, rect.bottom);
        const dx = distance(x, rect.left, rect.right);
        return !best || dy < best.dy || (dy === best.dy && dx < best.dx) ? { element, dy, dx } : best;
    }, null).element;
}
