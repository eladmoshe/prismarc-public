import { INLINE_SWITCHER } from './tab-switcher-inline-settings.js';
import { INLINE_MESSAGE, attachInlineListener, inlinePage, registerInlineSwitcher } from './tab-switcher-inline-registration.js';
import { confirmQuickSwitcherDeletion } from './quick-switcher-window.js';
import { historyDestinationIdentity } from './quick-switcher-search.js';
import { activeSwitcherSource, usesOptionShortcut } from './tab-switcher-tabs.js';

const FRAME_PAGE = 'tab-switcher.html';
const SEARCH_PAGE = 'quick-switcher.html';
const PICKER_READY_MS = 1500;
const SEARCH_FOCUS_MS = 600;
const HOST_REPLY_MS = 500;

function waitForHost(reply, timeoutValue) {
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, HOST_REPLY_MS, timeoutValue); });
    return Promise.race([reply, timeout]).finally(() => clearTimeout(timer));
}

export class TabSwitcherOverlay {
    constructor(chromeApi, { input, lost }) {
        this.chrome = chromeApi;
        this.input = input;
        this.lost = lost;
    }

    register() {
        registerInlineSwitcher(this.chrome, () => this.reset());
        this.chrome.runtime.onConnect.addListener(port => {
            if (port.name !== 'recent-tabs-inline-lifetime') return;
            const attempt = this.current;
            if (!attempt || !this.matchesSource(attempt, port.sender) || port.sender.documentId !== attempt.host) {
                port.disconnect();
                return;
            }
            port.onMessage.addListener(nonce => {
                if (this.current !== attempt || nonce !== attempt.nonce) port.disconnect();
            });
            port.onDisconnect.addListener(() => {
                if (this.current === attempt) this.reset();
            });
        });
    }

    async available(source, page = FRAME_PAGE) {
        if (!source || source.incognito || !inlinePage(source.url) || source.pendingUrl || !this.chrome.scripting) return false;
        const url = new URL(source.url);
        const origin = url.protocol + '//' + url.hostname;
        const settings = await this.chrome.storage.local.get(INLINE_SWITCHER);
        if (settings[INLINE_SWITCHER] !== true) return false;
        if (page === SEARCH_PAGE) return this.chrome.permissions.contains({ origins: [origin + '/*'], permissions: ['scripting'] });
        const [permission, commands, platform] = await Promise.all([
            this.chrome.permissions.contains({ origins: [origin + '/*'], permissions: ['scripting'] }),
            this.chrome.commands.getAll(),
            this.chrome.runtime.getPlatformInfo(),
        ]);
        return platform.os === 'mac' && permission && usesOptionShortcut(commands);
    }

    send(attempt, action, options, extra = {}) {
        const { source, nonce, pressedAt } = attempt;
        return this.chrome.tabs.sendMessage(source.id, { type: INLINE_MESSAGE, action, nonce, pressedAt, ...extra }, options);
    }

    async open(source, token, pressedAt, prepare = () => {}) {
        if (!await this.available(source)) return false;
        if (this.current?.page === SEARCH_PAGE) await this.close(this.current.token);
        return this.openFrame(source, token, FRAME_PAGE, pressedAt, prepare);
    }

    async openSearch(source) {
        if (this.current?.page === SEARCH_PAGE) {
            const sameTab = this.current.source.id === source?.id;
            await this.close(this.current.token);
            if (sameTab) return true;
        }
        if (!await this.available(source, SEARCH_PAGE)) return false;
        if (this.current?.page === FRAME_PAGE) await this.input(this.current.token, 'cancel');
        return this.openFrame(source, crypto.randomUUID(), SEARCH_PAGE);
    }

    async openFrame(source, token, page, pressedAt, prepare) {
        if (this.current) return false;
        let settle;
        const ready = new Promise(resolve => { settle = resolve; });
        let focus;
        const focused = page === SEARCH_PAGE ? new Promise(resolve => { focus = resolve; }) : null;
        const attempt = { source, token, page, nonce: crypto.randomUUID(), pressedAt, settle, focus };
        this.current = attempt;
        let timer = setTimeout(() => settle(false), PICKER_READY_MS);
        try {
            await prepare?.();
            if (this.current !== attempt) return attempt.interrupted === true;
            if (page === SEARCH_PAGE) this.mount(attempt);
            else this.send(attempt, 'probe').then(found => { if (!found) settle(false); }, () => settle(false));
            if (!await ready || this.current !== attempt) return attempt.interrupted === true;
            clearTimeout(timer);
            if (attempt.keyDocument) this.send(attempt, 'armed', { documentId: attempt.keyDocument }).catch(() => {});
            const host = { documentId: attempt.host };
            if (focused) {
                // Keyboard focus has its own deadline. The overlay stays transparent until input is ready.
                timer = setTimeout(() => focus(false), SEARCH_FOCUS_MS);
                this.send(attempt, 'focus', host).then(accepted => { if (!accepted) focus(false); }, () => focus(false));
                if (!await focused || this.current !== attempt) return attempt.interrupted === true;
            }
            attempt.showing = true;
            const stopped = new Promise(resolve => { attempt.stopShowing = resolve; });
            const shown = await waitForHost(Promise.race([this.send(attempt, 'show', host).catch(() => false), stopped]), null);
            if (shown === null && this.current === attempt) this.reset();
            if (shown && this.current === attempt) {
                attempt.visible = true;
                if (attempt.released) this.input(attempt.token, 'commit');
                return true;
            }
        } finally {
            clearTimeout(timer);
            if (!attempt.visible) await this.close(token);
        }
        // The host can disappear after revealing the frame but before replying.
        return attempt.interrupted === true;
    }

    async mount(attempt) {
        const extra = attempt.page === SEARCH_PAGE ? { page: SEARCH_PAGE } : {};
        const mounted = await this.send(attempt, 'mount', { frameId: 0 }, extra).catch(error => {
            if (/Receiving end does not exist/i.test(error?.message)) {
                return this.attachHost(attempt, extra).catch(() => false);
            }
            return false;
        });
        if (!mounted) attempt.settle(false);
    }

    async attachHost(attempt, extra) {
        // An already-open document can predate registration. Repair a missing
        // receiver on the opted-in active tab using only the packaged listener.
        if (!await this.stillOnSource(attempt) || !await this.available(attempt.source, attempt.page) || this.current !== attempt) return false;
        const [injected] = await attachInlineListener(this.chrome, attempt.source.id);
        if (injected?.frameId !== 0 || !injected.documentId || !await this.stillOnSource(attempt) || this.current !== attempt) return false;
        attempt.intendedHost = injected.documentId;
        return this.send(attempt, 'mount', { documentId: injected.documentId }, extra);
    }

    async stillOnSource({ source }) {
        return Boolean(!source.incognito && !source.pendingUrl && await activeSwitcherSource(this.chrome, source));
    }

    async confirmsInlineRoute(attempt, documentId) {
        const target = { documentId };
        const route = { url: attempt.source.url };
        const confirmed = await this.send(attempt, 'confirm-route', target, route).catch(() => false);
        return confirmed === true && this.current === attempt && await this.stillOnSource(attempt) && this.current === attempt;
    }

    close(token) {
        const attempt = this.current;
        if (attempt?.token !== token) return;
        this.current = null;
        attempt.settle(false);
        attempt.focus?.(false);
        attempt.stopShowing?.(false);
        // A nested input frame must not acknowledge removal of the top frame.
        const documents = new Set([attempt.host, attempt.keyDocument].filter(Boolean));
        const close = documentId => this.send(attempt, 'close', { documentId });
        return waitForHost(Promise.allSettled([...documents].map(close))).then(() => {
            if (this.covered === attempt) {
                this.covered = null;
                this.coverVersion++;
            }
        });
    }

    reset() {
        const attempt = this.current;
        if (attempt) {
            this.close(attempt.token);
            if (attempt.visible || attempt.showing) {
                attempt.interrupted = true;
                if (attempt.page === FRAME_PAGE) this.lost(attempt.token);
            }
        }
    }

    ownsGesture(token) {
        const attempt = this.current;
        return attempt?.token === token && attempt.visible === true;
    }

    isOnTab(tabId) {
        return Boolean(this.current?.host && this.current.page !== SEARCH_PAGE && this.current.source.id === tabId);
    }

    sourceChanged(tabId, change, tab) {
        const attempt = this.current;
        if (attempt?.source.id !== tabId) return;
        // A loading notification alone does not identify a different document.
        if (!change || change.discarded || tab?.pendingUrl || tab?.url !== attempt.source.url) this.reset();
    }

    tabActivated({ tabId, windowId }) {
        const attempt = this.current;
        if (attempt && !attempt.activating && attempt.source.windowId === windowId && attempt.source.id !== tabId) {
            this.reset();
        }
    }

    coversTab(tabId) {
        return this.covered?.source.id === tabId;
    }

    isOverlayFrame(sender, page = FRAME_PAGE) {
        const runtime = this.chrome.runtime;
        const urls = [runtime.getURL(page), `chrome-extension://${runtime.id}/${page}`];
        return sender?.frameId > 0 && urls.includes(sender.url) &&
            urls.some(url => sender.origin === url.slice(0, url.lastIndexOf('/')));
    }

    authorizes(session, sender) {
        const attempt = this.current;
        return attempt && session && attempt.token === session.token && attempt.open && this.matchesSource(attempt, sender) &&
            this.isOverlayFrame(sender) && sender.documentId === attempt.renderer;
    }

    matchesSource(attempt, sender) {
        return sender.id === this.chrome.runtime.id && sender.tab?.id === attempt.source.id &&
            !sender.tab.incognito && sender.tab.windowId === attempt.source.windowId &&
            sender.documentLifecycle === 'active' && typeof sender.documentId === 'string';
    }

    receive(message, sender) {
        const attempt = this.current;
        if (!attempt || message?.type !== INLINE_MESSAGE || message.nonce !== attempt.nonce ||
            !this.matchesSource(attempt, sender)) return;
        if (message.action === 'renderer') return this.acceptRenderer(attempt, sender);
        if (message.action === 'interactive' && attempt.renderer === sender.documentId &&
            this.isOverlayFrame(sender, attempt.page)) {
            attempt.settle(true);
            return Promise.resolve({});
        }
        if (attempt.page === SEARCH_PAGE && attempt.renderer === sender.documentId && this.isOverlayFrame(sender, SEARCH_PAGE)) {
            if (message.action === 'focused') {
                attempt.focus(true);
                return Promise.resolve({});
            }
            if (message.action === 'dismiss') {
                attempt.interrupted = true;
                return this.close(attempt.token).then(() => ({}));
            }
            if (message.action === 'confirmDelete') return this.confirmDelete(attempt, message.details);
            if (message.action === 'activate') return this.verifySearch(attempt, true);
            if (message.action === 'resume') {
                attempt.activating = false;
                return this.verifySearch(attempt).then(result => {
                    if (!result.valid) this.close(attempt.token);
                    return result;
                });
            }
        }
        if (!inlinePage(sender.url)) return;
        switch (message.action) {
            case 'probe':
            case 'released-probe':
                if (attempt.keyDocument) return;
                attempt.keyDocument = sender.documentId;
                attempt.released = message.action === 'released-probe';
                this.mount(attempt);
                return Promise.resolve({});
            case 'host': return this.acceptHost(attempt, sender);
            case 'release':
            case 'next':
            case 'previous':
            case 'commit':
            case 'cancel':
            case 'previewSettings':
            case 'dismissPreviewHint':
                if (sender.documentId !== attempt.keyDocument) return;
                if (message.action === 'release') attempt.released = true;
                if (attempt.visible) this.input(attempt.token, message.action === 'release' ? 'commit' : message.action);
                return Promise.resolve({});
            case 'lost':
                if (sender.documentId === attempt.host && !attempt.activating) this.reset();
                return Promise.resolve({});
        }
    }

    async acceptHost(attempt, sender) {
        if (sender.frameId !== 0 || attempt.host || (attempt.intendedHost && sender.documentId !== attempt.intendedHost)) {
            return { success: false };
        }
        if (sender.url !== attempt.source.url) {
            // On a single-page route Chrome retains the original sender.url.
            // Verify Chrome's current tab URL AND the exact current route in the
            // active top document that received this invocation's capability.
            const origin = new URL(attempt.source.url).origin;
            if (sender.origin !== origin || new URL(sender.url).origin !== origin ||
                sender.tab.url !== attempt.source.url || !await this.confirmsInlineRoute(attempt, sender.documentId) || attempt.host) {
                return { success: false };
            }
        }
        attempt.host = sender.documentId;
        this.covered = attempt;
        this.coverVersion = (this.coverVersion || 0) + 1;
        return {};
    }

    setPreviewHint(token, visible) {
        const attempt = this.current;
        if (attempt?.token !== token) return;
        attempt.previewHint = visible === true;
        this.send(attempt, 'previewHint', { documentId: attempt.keyDocument }, { visible: attempt.previewHint }).catch(() => {});
    }

    hasPreviewHint(token) {
        const attempt = this.current;
        return attempt?.token === token && attempt.previewHint === true;
    }

    async verifySearch(attempt, activating = false) {
        const live = await this.stillOnSource(attempt) && await this.available(attempt.source, SEARCH_PAGE);
        const valid = Boolean(live && this.current === attempt && attempt.visible);
        if (valid && activating) attempt.activating = true;
        return { valid };
    }

    async confirmDelete(attempt, draft) {
        const { query, urls } = draft ?? {};
        if (typeof query !== 'string' || query.length > 1000 || !Array.isArray(urls) || urls.length < 1 ||
            urls.length > 100 || urls.some(url => typeof url !== 'string')) return { accepted: false };
        const identity = historyDestinationIdentity(urls[0]);
        if (!identity || urls.some(url => historyDestinationIdentity(url) !== identity)) return { accepted: false };
        const accepted = await confirmQuickSwitcherDeletion(this.chrome, attempt.source, { query, urls },
            async () => (await this.verifySearch(attempt, true)).valid).catch(() => false);
        if (accepted) await this.close(attempt.token);
        else {
            attempt.activating = false;
            if (!(await this.verifySearch(attempt)).valid) await this.close(attempt.token);
        }
        return { accepted };
    }

    async acceptRenderer(attempt, sender) {
        if (!attempt.host || attempt.renderer || !this.isOverlayFrame(sender, attempt.page) || !await this.stillOnSource(attempt) ||
            this.current !== attempt || attempt.renderer) return;
        attempt.renderer = sender.documentId;
        attempt.open = true;
        return attempt.page === SEARCH_PAGE
            ? { token: attempt.token, windowId: attempt.source.windowId }
            : { token: attempt.token };
    }
}
