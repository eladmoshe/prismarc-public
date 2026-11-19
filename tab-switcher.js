import { isTrustedExtensionMessage } from './message-security.js';
import { focusOpenTab, recentOpenTabs, TAB_FOCUS_TIMES } from './tab-switcher-tabs.js';

export const TAB_SWITCHER_SESSION = 'openTabSwitcher';
export const TAB_SWITCHER_PAGE = 'tab-switcher.html';
export const TAB_SWITCHER_LIMIT = 5;
const PRIVATE_BURST_MS = 800;

export class TabSwitcher {
    constructor(chromeApi, previews) {
        this.chrome = chromeApi;
        this.previews = previews;
        this.privateCycle = null;
        this.popupOpenedAt = 0;
        this.pending = Promise.resolve();
    }

    run(operation) {
        const result = this.pending.then(operation);
        this.pending = result.catch(() => {});
        return result;
    }

    async session() {
        const stored = await this.chrome.storage.session.get(TAB_SWITCHER_SESSION);
        return stored[TAB_SWITCHER_SESSION];
    }

    save(session) {
        return this.chrome.storage.session.set({ [TAB_SWITCHER_SESSION]: session });
    }

    clear() {
        return this.chrome.storage.session.remove(TAB_SWITCHER_SESSION);
    }

    async tabFocusTimes() {
        const stored = await this.chrome.storage.session.get(TAB_FOCUS_TIMES);
        return stored[TAB_FOCUS_TIMES] ?? {};
    }

    pageUrl(token = '') {
        return this.chrome.runtime.getURL(TAB_SWITCHER_PAGE) + '#' + token;
    }

    invoke(tab, pressedAt = Date.now()) {
        if (tab?.incognito === false && /^https?:\/\//i.test(tab.url)) {
            try {
                // Start the best-effort foreground capture before reading the
                // candidate list. Preview work must not delay picker focus.
                this.previews?.capture(tab)?.catch(() => {});
            } catch {
                // Tabs remain switchable when the browser rejects capture.
            }
        }
        return this.run(async () => {
            const source = tab ?? (await this.chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
            if (!source) return;
            const session = await this.session();
            if (session && [source.url, source.pendingUrl].includes(this.pageUrl(session.token))) {
                await this.move(session, 1);
                return;
            }
            // Chrome can still associate a repeat with the original tab
            // while transferring shortcut dispatch to the focused picker.
            if (session && session.originId === source.id &&
                (pressedAt <= this.popupOpenedAt || (await this.findPopup(session))?.focused)) {
                await this.move(session, 1);
                return;
            }
            if (session) await this.finish(session);

            const tabs = await recentOpenTabs(this.chrome, source, this.tabFocusTimes());
            if (tabs[0]?.id !== source.id) return;
            if (source.incognito) {
                await this.switchPrivate(source, tabs, pressedAt);
                return;
            }
            this.privateCycle = null;
            const tabIds = tabs.slice(0, TAB_SWITCHER_LIMIT).map(tab => tab.id);
            if (tabIds.length < 2) return;
            await this.open(tabIds, tabs[0].windowId);
        });
    }

    async switchPrivate(source, tabs, pressedAt) {
        const previous = this.privateCycle;
        this.privateCycle = null;
        const visibleIds = tabs.map(tab => tab.id);
        let tabIds = visibleIds.slice(0, TAB_SWITCHER_LIMIT);
        let index = 0;
        if (previous && pressedAt <= previous.expiresAt &&
            (previous.targetId === source.id ||
                (previous.beforeId === source.id && pressedAt <= previous.focusedAt))) {
            const live = new Set(visibleIds);
            const remaining = previous.tabIds.filter(id => live.has(id));
            if (remaining.includes(previous.targetId)) {
                tabIds = remaining;
                index = tabIds.indexOf(previous.targetId);
            }
        }
        if (tabIds.length < 2) return;
        const targetId = tabIds[(index + 1) % tabIds.length];
        const touched = await focusOpenTab(this.chrome, targetId);
        this.privateCycle = {
            beforeId: tabIds[index],
            targetId,
            targetWindowId: touched.windowId,
            tabIds,
            expiresAt: pressedAt + PRIVATE_BURST_MS,
            focusedAt: Date.now(),
        };
    }

    tabActivated({ tabId, windowId }) {
        if (this.privateCycle && this.privateCycle.targetWindowId === windowId && this.privateCycle.targetId !== tabId) {
            this.privateCycle = null;
        }
    }

    windowFocused(windowId, focusedAt = Date.now()) {
        if (windowId < 0) return Promise.resolve();
        if (this.privateCycle && this.privateCycle.targetWindowId !== windowId) {
            this.privateCycle = null;
        }
        return this.run(async () => {
            const window = await this.chrome.windows.get(windowId, { populate: true }).catch(() => null);
            if (window?.type !== 'normal' || !window.focused) return;
            const active = window.tabs?.find(tab => tab.active);
            if (Number.isInteger(active?.id) && active.id >= 0) {
                // Moving between windows can leave the selected tab's native
                // lastAccessed unchanged. Retain only IDs and focus times.
                const times = await this.tabFocusTimes();
                times[active.id] = focusedAt;
                await this.chrome.storage.session.set({ [TAB_FOCUS_TIMES]: times });
            }
            const session = await this.session();
            if (!session || focusedAt <= this.popupOpenedAt) return;
            await this.finish(session);
        });
    }

    async open(tabIds, windowId) {
        const preferredWidth = 32 + tabIds.length * 120;
        const session = {
            token: crypto.randomUUID(),
            originId: tabIds[0],
            originWindowId: windowId,
            tabIds,
            selectedId: tabIds[1],
            incognito: false,
        };
        try {
            const [window] = await Promise.all([this.chrome.windows.get(windowId), this.save(session)]);
            const width = Math.min(preferredWidth, window.width ?? preferredWidth);
            const height = Math.min(212, window.height ?? 212);
            const options = {
                url: this.pageUrl(session.token), type: 'popup', focused: true,
                incognito: session.incognito, width, height,
            };
            try {
                await this.chrome.windows.create({
                    ...options,
                    left: (window.left ?? 0) + Math.round(((window.width ?? width) - width) / 2),
                    top: (window.top ?? 0) + Math.round(((window.height ?? height) - height) / 2),
                });
            } catch (error) {
                if (!/bounds.*visible screen space/i.test(error.message)) throw error;
                await this.chrome.windows.create(options);
            }
            this.popupOpenedAt = Date.now();
        } catch (error) {
            await this.finish(session);
            throw error;
        }
    }

    receive(message, sender) {
        if (message?.type !== TAB_SWITCHER_SESSION || !isTrustedExtensionMessage(message, sender, this.chrome) ||
            !sender.url?.startsWith(this.pageUrl())) return;
        if (message.action === 'previews') return this.previewResponse(sender);
        return this.run(async () => {
            const session = await this.session();
            if (!this.isCurrentPicker(session, sender)) return;
            switch (message.action) {
                case 'next': return this.move(session, 1);
                case 'previous': return this.move(session, -1);
                case 'cancel': return this.finish(session, session.originId);
                case 'commit': {
                    const target = message.tabId ?? session.selectedId;
                    if (session.tabIds.includes(target)) return this.finish(session, target);
                    break;
                }
            }
        });
    }

    isCurrentPicker(session, sender) {
        return session && sender.tab && Boolean(sender.tab.incognito) === session.incognito &&
            sender.url === this.pageUrl(session.token);
    }

    async previewResponse(sender) {
        const session = await this.session();
        if (!this.isCurrentPicker(session, sender)) return;
        const previews = await this.previews?.get(session.tabIds);
        return { previews: previews ?? {} };
    }

    move(session, direction) {
        const index = session.tabIds.indexOf(session.selectedId);
        const count = session.tabIds.length;
        const selectedId = session.tabIds[(index + direction + count) % count];
        return this.save({ ...session, selectedId });
    }

    async finish(session, tabId) {
        try {
            if (Number.isInteger(tabId)) {
                const tab = await this.chrome.tabs.get(tabId).catch(() => null);
                if (tab && Boolean(tab.incognito) === session.incognito) await focusOpenTab(this.chrome, tab.id);
            }
        } finally {
            const popup = await this.findPopup(session);
            if (popup) await this.chrome.windows.remove(popup.id);
            await this.clear();
        }
    }

    removeTab(tabId) {
        return this.run(async () => {
            const times = await this.tabFocusTimes();
            if (Object.hasOwn(times, tabId)) {
                delete times[tabId];
                await this.chrome.storage.session.set({ [TAB_FOCUS_TIMES]: times });
            }
            const session = await this.session();
            if (!session?.tabIds.includes(tabId)) return;
            const tabIds = session.tabIds.filter(id => id !== tabId);
            if (tabIds.length < 2) {
                await this.finish(session);
                return;
            }
            const selectedId = tabId === session.selectedId
                ? tabIds[session.tabIds.indexOf(tabId) % tabIds.length] : session.selectedId;
            await this.save({ ...session, tabIds, selectedId });
        });
    }

    async findPopup(session) {
        const url = this.pageUrl(session.token);
        const windows = await this.chrome.windows.getAll({ windowTypes: ['popup'], populate: true });
        return windows.find(window => window.type === 'popup' && Boolean(window.incognito) === session.incognito &&
            window.tabs?.some(tab => tab.url === url || tab.pendingUrl === url));
    }

    removeWindow() {
        return this.run(async () => {
            const session = await this.session();
            if (session && !(await this.findPopup(session))) await this.clear();
        });
    }
}
