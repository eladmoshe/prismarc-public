import { INLINE_SWITCHER } from './tab-switcher-inline-settings.js';
import { INLINE_MESSAGE, inlinePage, registerInlineSwitcher } from './tab-switcher-inline-registration.js';

const FRAME_PAGE = 'tab-switcher.html';
const READY_MS = 300;

function usesOption(commands) {
    const shortcut = commands.find(command => command.name === 'cycleOpenTabs')?.shortcut ?? '';
    return shortcut.includes('⌥') || /(?:^|\+)(?:Alt|Option)(?:\+|$)/i.test(shortcut);
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

    async available(source) {
        if (source.incognito || !inlinePage(source.url) || source.pendingUrl || !this.chrome.scripting) return false;
        const url = new URL(source.url);
        const origin = url.protocol + '//' + url.hostname;
        const settings = await this.chrome.storage.local.get(INLINE_SWITCHER);
        if (settings[INLINE_SWITCHER] !== true) return false;
        const [permission, commands, platform] = await Promise.all([
            this.chrome.permissions.contains({ origins: [origin + '/*'], permissions: ['scripting'] }),
            this.chrome.commands.getAll(),
            this.chrome.runtime.getPlatformInfo(),
        ]);
        return platform.os === 'mac' && permission && usesOption(commands);
    }

    send(attempt, action, options, extra = {}) {
        const { source, nonce, pressedAt } = attempt;
        return this.chrome.tabs.sendMessage(source.id, { type: INLINE_MESSAGE, action, nonce, pressedAt, ...extra }, options);
    }

    async open(source, token, pressedAt, prepare = () => {}) {
        if (!await this.available(source)) return false;
        await prepare();
        let settle;
        const ready = new Promise(resolve => { settle = resolve; });
        const attempt = { source, token, nonce: crypto.randomUUID(), pressedAt, settle };
        this.current = attempt;
        const timer = setTimeout(() => settle(false), READY_MS);
        this.send(attempt, 'probe').then(found => { if (!found) settle(false); }, () => settle(false));
        try {
            if (await ready && this.current === attempt ) {
                this.send(attempt, 'armed', { documentId: attempt.keyDocument }).catch(() => {});
                const shown = await this.send(attempt, 'show', { documentId: attempt.host }).catch(() => false);
                if (shown && this.current === attempt) {
                    attempt.visible = true;
                    if (attempt.released) this.input(attempt.token, 'commit');
                    return true;
                }
            }
        } finally {
            clearTimeout(timer);
            if (!attempt.visible) await this.close(token);
        }
        return false;
    }

    async stillOnSource({ source }) {
        const window = await this.chrome.windows.get(source.windowId, { populate: true }).catch(() => null);
        return window?.focused && window.type === 'normal' && !window.incognito &&
            window.tabs?.some(tab => tab.id === source.id && tab.active && tab.url === source.url && !tab.pendingUrl);
    }

    close(token) {
        const attempt = this.current;
        if (attempt?.token !== token) return;
        this.current = null;
        attempt.settle(false);
        // A nested input frame must not acknowledge removal of the top frame.
        const documents = new Set([attempt.host, attempt.keyDocument].filter(Boolean));
        const close = documentId => this.send(attempt, 'close', { documentId });
        return Promise.allSettled([...documents].map(close)).then(() => {
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
            if (attempt.visible) this.lost(attempt.token);
        }
    }

    ownsGesture(token) {
        const attempt = this.current;
        return attempt?.token === token && attempt.visible === true;
    }

    isOnTab(tabId) {
        return Boolean(this.current?.host && this.current.source.id === tabId);
    }

    coversTab(tabId) {
        return this.covered?.source.id === tabId;
    }

    isOverlayFrame(sender) {
        const runtime = this.chrome.runtime;
        const urls = [runtime.getURL(FRAME_PAGE), `chrome-extension://${runtime.id}/${FRAME_PAGE}`];
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
        if (!inlinePage(sender.url)) return;
        switch (message.action) {
            case 'probe':
            case 'released-probe':
                if (attempt.keyDocument) return;
                attempt.keyDocument = sender.documentId;
                attempt.released = message.action === 'released-probe';
                this.send(attempt, 'mount', { frameId: 0 }).then(mounted => {
                    if (!mounted) attempt.settle(false);
                }, () => attempt.settle(false));
                return Promise.resolve({});
            case 'host':
                if (sender.frameId !== 0 || sender.url !== attempt.source.url || attempt.host) return;
                attempt.host = sender.documentId;
                this.covered = attempt;
                this.coverVersion = (this.coverVersion || 0) + 1;
                return Promise.resolve({});
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
                if (sender.documentId === attempt.host) this.reset();
                return Promise.resolve({});
        }
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

    async acceptRenderer(attempt, sender) {
        if (!attempt.host || attempt.renderer || !this.isOverlayFrame(sender) || !await this.stillOnSource(attempt) ||
            this.current !== attempt || attempt.renderer) return;
        attempt.renderer = sender.documentId;
        attempt.open = true;
        attempt.settle(true);
        return { token: attempt.token };
    }
}
