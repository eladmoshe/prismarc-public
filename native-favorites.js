import { Logger } from './logger.js';

export const MAX_FAVORITES = 12;
const SNAPSHOT_KEY = 'nativeFavoriteSnapshot';
const SESSION_KEY = 'nativeFavoritesSession';
const SINGLE_WINDOW_KEY = 'nativeFavoriteSingleWindowGroup';
const tabUrl = tab => tab.pendingUrl || tab.url || '';

// Closed entries retain their logical slots while Chrome orders the remaining live pins.
function arrange(live, closed) {
    const result = [...live];
    for (const item of [...closed].sort((a, b) => a.index - b.index)) {
        result.splice(Math.min(item.index, result.length), 0, item);
    }
    return result;
}

export class NativeFavorites {
    constructor() {
        this.chain = Promise.resolve();
        this.records = new Map(); // Chrome tab id -> live Favorite
        this.closed = new Map(); // stable Favorite id -> unloaded Favorite
        this.restoreQueue = [];
        this.windowGroups = new Map(); // session-local window id -> persistent group
        this.normalWindows = new Set();
    }

    run(operation) {
        const pending = this.chain.then(async () => {
            if (!this.initialized) await this.initialize();
            return operation();
        });
        this.chain = pending.catch(() => {});
        return pending;
    }

    groupFor(windowId) {
        if (!this.windowGroups.has(windowId)) this.windowGroups.set(windowId, crypto.randomUUID());
        return this.windowGroups.get(windowId);
    }

    async initialize() {
        const { [SNAPSHOT_KEY]: snapshot = [] } = await chrome.storage.local.get(SNAPSHOT_KEY);
        const { [SESSION_KEY]: session } = await chrome.storage.session.get(SESSION_KEY);
        const tabs = await chrome.tabs.query({});
        const regularWindows = chrome.windows?.getAll
            ? (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter(w => !w.incognito).map(w => w.id)
            : [...new Set(tabs.filter(t => !t.incognito).map(t => t.windowId))];
        this.normalWindows = new Set(regularWindows);
        const previous = await chrome.storage.local.get(SINGLE_WINDOW_KEY);
        this.singleWindowGroup = previous[SINGLE_WINDOW_KEY] || null;
        this.pendingSingleGroup = session?.pendingSingleGroup || (!session && !regularWindows.length ? this.singleWindowGroup : null);
        const live = snapshot.filter(record => !record.closed);
        for (const record of snapshot.filter(record => record.closed)) this.closed.set(record.favoriteId, record);
        if (session) {
            this.windowGroups = new Map((session.windowGroups || []).filter(([id]) => this.normalWindows.has(id)));
            this.restoreQueue = session.restoreQueue || [];
            const queued = new Set(this.restoreQueue.map(record => record.favoriteId || record.tabId));
            // onRemoved can be the event that wakes this worker. The removed tab
            // is already absent from Chrome's query but its saved identity is still needed.
            for (const record of live) {
                if (!queued.has(record.favoriteId || record.tabId)) this.records.set(record.tabId, record);
            }
        } else this.restoreQueue = live;
        this.bindRestoredWindows(tabs.filter(tab => tab.pinned && !tab.incognito));
        const soleOwner = session ? this.pendingSingleGroup : this.singleWindowGroup;
        if (regularWindows.length === 1 && soleOwner && !this.windowGroups.has(regularWindows[0])) {
            this.windowGroups.set(regularWindows[0], soleOwner);
        }
        if (regularWindows.length) this.pendingSingleGroup = null;
        for (const id of regularWindows) this.groupFor(id);
        for (const tab of tabs) if (tab.pinned) this.track(tab);
        // Old records have no regular/private window marker. Migrate matches to
        // currently visible native pins, without retaining unidentifiable URLs.
        this.restoreQueue = this.restoreQueue.filter(record => record.group);
        this.initialized = true;
        await this.persist();
    }

    // Chrome can restore tabs after startup. Match window groups in either direction
    // only when the saved and current native pins provide unambiguous URL evidence.
    bindRestoredWindows(pinned) {
        if (!this.restoreQueue.length) return;
        const anchors = [];
        for (const tab of pinned) {
            const url = tabUrl(tab), matches = this.restoreQueue.filter(saved => saved.url === url);
            if (url && matches.length === 1 && matches[0].group && pinned.filter(other => tabUrl(other) === url).length === 1) {
                anchors.push({ id: tab.windowId, group: matches[0].group });
            }
        }
        for (const { id, group } of anchors) {
            const current = this.windowGroups.get(id);
            if (current === group) continue;
            if (anchors.some(other => (other.id === id) !== (other.group === group))) continue;
            if ([...this.windowGroups].some(([other, assigned]) => other !== id && assigned === group)) continue;
            if (current && [...this.records.values(), ...this.closed.values()].some(record => record.group === current)) continue;
            this.windowGroups.set(id, group);
        }
    }

    removeSlot(removed) {
        if (removed?.group) {
            for (const record of [...this.closed.values(), ...this.records.values()]) {
                if (record.group === removed.group && record.index > removed.index) record.index--;
            }
        }
    }

    detach(id) {
        this.removeSlot(this.records.get(id));
        this.records.delete(id);
    }

    track(tab, restore = true) {
        if (!tab.pinned) { this.detach(tab.id); return; }
        const url = tabUrl(tab);
        if (!url) return;
        const group = tab.incognito ? null : this.groupFor(tab.windowId);
        let record = this.records.get(tab.id);
        if (record?.group && record.group !== group) this.detach(tab.id);
        if (!record && restore && !tab.incognito) {
            const index = this.restoreQueue.findIndex(saved => saved.url === url && (!saved.group || saved.group === group));
            if (index >= 0) record = this.restoreQueue.splice(index, 1)[0];
        }
        let index = tab.index;
        for (const item of [...this.closed.values()].filter(item => item.group === group).sort((a, b) => a.index - b.index)) {
            if (item.index <= index) index++;
        }
        this.records.set(tab.id, { favoriteId: record?.favoriteId || (tab.incognito ? `private-${tab.id}` : crypto.randomUUID()),
            tabId: tab.id, group, index: record?.index ?? index, url, baseUrl: record?.baseUrl || url,
            title: record?.title || tab.title || url });
    }

    async persist() {
        const snapshot = [...this.records.values()].filter(record => record.group);
        if (this.normalWindows.size) this.singleWindowGroup = this.normalWindows.size === 1
            ? this.groupFor([...this.normalWindows][0]) : null;
        // A closed window with no live/restorable landmark and no single-window
        // association can never own these entries again.
        const recoverable = new Set([...this.windowGroups.values(), this.singleWindowGroup, this.pendingSingleGroup,
            ...snapshot.map(record => record.group), ...this.restoreQueue.map(record => record.group)]);
        for (const [id, record] of this.closed) if (!recoverable.has(record.group)) this.closed.delete(id);
        const local = { [SNAPSHOT_KEY]: [...snapshot, ...this.closed.values(), ...this.restoreQueue],
            [SINGLE_WINDOW_KEY]: this.singleWindowGroup };
        const session = { restoreQueue: this.restoreQueue, windowGroups: [...this.windowGroups], pendingSingleGroup: this.pendingSingleGroup };
        const localJson = JSON.stringify(local), sessionJson = JSON.stringify(session);
        if (localJson !== this.lastLocal) {
            await chrome.storage.local.set(local);
            this.lastLocal = localJson;
        }
        if (sessionJson !== this.lastSession) {
            await chrome.storage.session.set({ [SESSION_KEY]: session });
            this.lastSession = sessionJson;
        }
    }

    async list(windowId) {
        const tabs = await chrome.tabs.query({ pinned: true, ...(Number.isInteger(windowId) ? { windowId } : {}) });
        for (const tab of tabs) this.track(tab);
        const windows = Number.isInteger(windowId) ? [windowId] : [...new Set([...this.windowGroups.keys(), ...tabs.map(t => t.windowId)])];
        return windows.flatMap(id => {
            const group = this.windowGroups.get(id);
            const live = tabs.filter(t => t.windowId === id && this.records.has(t.id)).sort((a, b) => a.index - b.index)
                .map(tab => ({ ...tab, ...this.records.get(tab.id) }));
            const closed = [...this.closed.values()].filter(record => record.group === group)
                .map(record => ({ ...record, id: null, windowId: id, active: false, pinned: true }));
            return arrange(live, closed).map((item, index) => {
                const record = item.closed ? this.closed.get(item.favoriteId) : this.records.get(item.id);
                if (record) record.index = index;
                return { ...item, index };
            });
        });
    }

    async pin(tabIds) {
        if (!Array.isArray(tabIds) || !tabIds.length || !tabIds.every(id => Number.isInteger(id) && id > 0)) {
            throw new Error('Choose tabs to add to Favorites.');
        }
        const selected = await Promise.all([...new Set(tabIds)].map(id => chrome.tabs.get(id)));
        for (const windowId of new Set(selected.map(tab => tab.windowId))) {
            const additions = selected.filter(tab => tab.windowId === windowId && !tab.pinned).length;
            const live = await chrome.tabs.query({ pinned: true, windowId });
            const unloaded = [...this.closed.values()].filter(item => item.group === this.windowGroups.get(windowId));
            if (additions && live.length + unloaded.length + additions > MAX_FAVORITES) {
                throw new Error(`Favorites is full. You can add up to ${MAX_FAVORITES} per window. Remove a Favorite to make room.`);
            }
        }
        for (const tab of selected) {
            await chrome.tabs.update(tab.id, { pinned: true });
            this.track({ ...tab, pinned: true }, tab.pinned);
        }
    }

    async changeFavorite({ action, favoriteId, favoriteIds, windowId }) {
        if (!Number.isInteger(windowId)) throw new Error('Choose a Favorites window.');
        const items = await this.list(windowId);
        if (action === 'reorder') {
            if (!Array.isArray(favoriteIds) || favoriteIds.length !== items.length || new Set(favoriteIds).size !== items.length ||
                !items.every(item => favoriteIds.includes(item.favoriteId))) throw new Error('Favorites changed. Try moving it again.');
            const byId = new Map(items.map(item => [item.favoriteId, item]));
            let nativeIndex = 0;
            for (const id of favoriteIds) {
                const item = byId.get(id);
                if (item.closed) continue;
                const tab = await chrome.tabs.get(item.id);
                if (!tab.pinned || tab.windowId !== windowId) throw new Error('Favorites changed. Try moving it again.');
                if (tab.index !== nativeIndex) await chrome.tabs.move(item.id, { index: nativeIndex });
                nativeIndex++;
            }
            for (const [index, id] of favoriteIds.entries()) {
                if (this.closed.has(id)) this.closed.get(id).index = index;
            }
            return;
        }
        const item = items.find(tab => typeof favoriteId === 'string' && tab.favoriteId === favoriteId);
        if (!item) throw new Error('This Favorite is no longer in this window.');
        if (action === 'remove') {
            if (item.closed) {
                this.closed.delete(favoriteId);
                this.removeSlot(item);
            }
            else {
                await chrome.tabs.update(item.id, { pinned: false });
                this.detach(item.id);
            }
        } else if (!item.closed) {
            await chrome.tabs.update(item.id, { active: true });
        } else {
            const index = items.slice(0, item.index).filter(tab => !tab.closed).length;
            const tab = await chrome.tabs.create({ windowId, url: item.baseUrl, pinned: true, active: true, index });
            const record = this.closed.get(favoriteId);
            this.records.set(tab.id, { ...record, closed: false, tabId: tab.id, url: item.baseUrl });
            this.closed.delete(favoriteId);
        }
    }

    dispatch(message) {
        return this.run(async () => {
            try {
                if (message.action === 'pin') await this.pin(message.tabIds);
                else if (['open', 'remove', 'reorder'].includes(message.action)) await this.changeFavorite(message);
                else if (message.action === 'reset') {
                    const tab = await chrome.tabs.get(message.tabId);
                    if (!tab.pinned) throw new Error('This tab is no longer a Favorite.');
                    this.track(tab);
                    const baseUrl = this.records.get(tab.id)?.baseUrl;
                    if (baseUrl) await chrome.tabs.update(tab.id, { url: baseUrl, active: true });
                } else if (message.action !== 'get') throw new Error('Unknown Favorites action.');
                return await this.list(message.windowId);
            } finally {
                await this.persist();
            }
        });
    }

    install() {
        const handle = operation => this.run(async () => { await operation(); await this.persist(); }).catch(Logger.error);
        const trackEvent = async (tab, restore) => {
            if (restore && tab.pinned && !tab.incognito && this.restoreQueue.length && !this.records.has(tab.id)) {
                const pinned = (await chrome.tabs.query({ pinned: true })).filter(t => !t.incognito);
                this.bindRestoredWindows(pinned);
            }
            this.track(tab, restore);
        };
        chrome.tabs.onCreated.addListener(tab => {
            if (tab.pinned) handle(() => trackEvent(tab, true));
        });
        chrome.tabs.onUpdated.addListener((id, change, tab) => {
            if (change.pinned === false) {
                // Chrome can report an unpin as it tears down a closed tab. An
                // intentional unpin leaves a live, unpinned tab in this window.
                handle(async () => {
                    const unpinned = await chrome.tabs.query({ windowId: tab.windowId, pinned: false });
                    if (unpinned.some(live => live.id === id)) this.detach(id);
                });
            } else if (change.pinned === true || (tab.pinned && change.url)) handle(() => trackEvent(tab, change.pinned !== true));
        });
        chrome.tabs.onRemoved.addListener((id, info) => handle(async () => {
            let record = this.records.get(id);
            if (record && !record.favoriteId && Number.isInteger(info?.windowId)) {
                // Older versions stored only the tab id and URLs. Upgrade a sleeping
                // worker's first close only when Chrome confirms its regular window.
                const window = await chrome.windows?.get?.(info.windowId).catch(() => null);
                if (window?.type === 'normal' && !window.incognito) {
                    record = { ...record, favoriteId: crypto.randomUUID(), group: this.groupFor(window.id),
                        index: (await this.list(window.id)).length };
                }
            }
            if (record?.group) {
                if (info?.isWindowClosing) {
                    this.restoreQueue.push(record);
                    const owner = [...this.windowGroups].find(([, value]) => value === record.group);
                    if (owner) {
                        this.normalWindows.delete(owner[0]);
                        this.windowGroups.delete(owner[0]);
                    }
                } else this.closed.set(record.favoriteId, { ...record, closed: true, tabId: null, url: record.baseUrl });
            }
            this.records.delete(id);
        }));
        chrome.tabs.onReplaced.addListener((added, removed) => handle(async () => {
            const record = this.records.get(removed);
            if (record) this.records.set(added, { ...record, tabId: added });
            this.records.delete(removed);
            this.track(await chrome.tabs.get(added));
        }));
        chrome.tabs.onMoved?.addListener((id, { windowId, fromIndex, toIndex }) => handle(async () => {
            const record = this.records.get(id);
            if (!record?.group) return;
            const live = [...this.records.values()].filter(item => item.group === record.group).sort((a, b) => a.index - b.index);
            if (live[fromIndex] !== record || !live[toIndex]) {
                await this.list(windowId);
                return;
            }
            // Apply the native move event in order, even if a subsequent close
            // has already removed the moved tab by the time a query would run.
            const slots = live.map(item => item.index);
            live.splice(fromIndex, 1);
            live.splice(toIndex, 0, record);
            live.forEach((item, index) => { item.index = slots[index]; });
        }));
        chrome.tabs.onAttached?.addListener((id, { newWindowId }) => handle(async () => {
            this.track(await chrome.tabs.get(id));
            await this.list(newWindowId);
        }));
        chrome.windows?.onCreated?.addListener(window => {
            if (window.type === 'normal' && !window.incognito) handle(() => {
                if (!this.normalWindows.size && this.pendingSingleGroup) this.windowGroups.set(window.id, this.pendingSingleGroup);
                this.pendingSingleGroup = null;
                this.normalWindows.add(window.id);
                this.groupFor(window.id);
            });
        });
        chrome.windows?.onRemoved?.addListener(id => handle(() => {
            this.normalWindows.delete(id);
            this.windowGroups.delete(id);
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
