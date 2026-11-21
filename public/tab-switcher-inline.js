// Runs only in Chrome's isolated world on opted-in, permitted web documents.
(() => {
    if (chrome.extension.inIncognitoContext) return;
    if (globalThis.prismArcInlineActivate) {
        globalThis.prismArcInlineActivate();
        return;
    }
    const type = 'recent-tabs-inline';
    const recentKeys = /^mac/i.test(navigator.userAgentData?.platform || navigator.platform);
    // onCommand can wake a cold worker after a release actually reached the page.
    const releaseFreshMs = 1000;
    const isOption = event => event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight';
    let gesture;
    let watch;
    let sheet;
    let mounting;
    let enabled = true;
    globalThis.prismArcInlineActivate = () => { enabled = true; };

    function send(action, nonce) {
        return chrome.runtime.sendMessage({ type, action, nonce }).catch(() => null);
    }

    function hide(nonce) {
        if (mounting === nonce) mounting = null;
        let previousFocus = watch?.nonce === nonce ? watch.focus : null;
        if (watch?.nonce === nonce) watch = null;
        if (sheet?.nonce === nonce) {
            const { host, frame, observer, port, heartbeat } = sheet;
            if (document.activeElement === host) {
                previousFocus = sheet.focus || previousFocus;
                if (sheet.search) frame.blur();
            }
            sheet = null;
            observer.disconnect();
            clearInterval(heartbeat);
            host.remove();
            port.disconnect();
        }
        if (previousFocus?.isConnected && previousFocus !== document.body) {
            requestAnimationFrame(() => {
                if (document.hasFocus() && document.activeElement === document.body) {
                    previousFocus.focus({ preventScroll: true });
                }
            });
        }
    }

    function mount(nonce, page) {
        if (!enabled || !document.documentElement || window.top !== window) return;
        if (sheet) hide(sheet.nonce);
        const host = document.createElement('div');
        const shadow = host.attachShadow({ mode: 'closed' });
        const frame = document.createElement('iframe');
        const search = page === 'quick-switcher.html';
        frame.title = search ? 'Quick Switcher' : 'Recent Tabs';
        frame.src = chrome.runtime.getURL(search ? page : 'tab-switcher.html');
        host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
        // Both picker documents use this same canvas scheme so Chromium can composite them transparently.
        frame.style.cssText = 'all:initial;color-scheme:only light;display:block;width:100%;height:100%;border:0;visibility:hidden;pointer-events:auto;';
        frame.addEventListener('load', () => {
            if (sheet?.nonce !== nonce) return;
            const dynamicOrigin = frame.src.slice(0, frame.src.lastIndexOf('/'));
            const stableOrigin = `chrome-extension://${chrome.runtime.id}`;
            // The only cross-document payload is an ephemeral capability.
            // Post exclusively to the owned frame at an extension origin.
            frame.contentWindow?.postMessage({ type, nonce }, dynamicOrigin);
            if (dynamicOrigin !== stableOrigin) frame.contentWindow?.postMessage({ type, nonce }, stableOrigin);
        });
        shadow.append(frame);
        const parent = document.documentElement;
        const observer = new MutationObserver(() => { if (!host.isConnected) send('lost', nonce); });
        const port = chrome.runtime.connect({ name: 'recent-tabs-inline-lifetime' });
        const keepPresent = () => {
            try { port.postMessage(nonce); } catch { hide(nonce); }
        };
        sheet = { nonce, host, frame, search, observer, port, heartbeat: setInterval(keepPresent, 20_000) };
        port.onDisconnect.addListener(() => hide(nonce));
        keepPresent();
        parent.append(host);
        observer.observe(parent, { childList: true });
    }

    if (recentKeys) window.addEventListener('keydown', event => {
        if (enabled && event.isTrusted && watch?.open && !event.ctrlKey && !event.metaKey) {
            const keys = { Escape: 'cancel', Enter: 'commit', ArrowRight: 'next', ArrowDown: 'next',
                ArrowLeft: 'previous', ArrowUp: 'previous' };
            let action = keys[event.key];
            if (event.altKey && event.shiftKey && event.key === 'Tab') action = 'previous';
            if (watch.previewHint && event.altKey && !event.repeat && event.code === 'KeyP') action = 'previewSettings';
            if (watch.previewHint && event.altKey && !event.repeat && event.code === 'KeyX') action = 'dismissPreviewHint';
            if (action) {
                event.preventDefault();
                event.stopImmediatePropagation();
                send(action, watch.nonce);
            }
        }
        if (!enabled || !event.isTrusted || watch) return;
        if (isOption(event) && !event.repeat && !event.ctrlKey && !event.metaKey) {
            const started = Date.now();
            const ambiguous = Boolean(gesture && !gesture.used && gesture.ended && started - gesture.ended <= releaseFreshMs);
            gesture = { started, ended: 0, used: false, ambiguous };
        } else if (gesture?.ended) {
            gesture = null;
        }
    }, true);
    if (recentKeys) window.addEventListener('keyup', event => {
        if (!enabled || !event.isTrusted || !isOption(event) || event.altKey || !gesture || gesture.ended) return;
        gesture.ended = Date.now();
        if (watch) send('release', watch.nonce);
    }, true);
    if (recentKeys) window.addEventListener('pointerdown', event => {
        if (event.isTrusted && !watch) gesture = null;
    }, true);
    function deactivate() {
        enabled = false;
        if (sheet) hide(sheet.nonce);
        gesture = watch = mounting = null;
    }
    window.addEventListener('blur', () => {
        if (!watch) gesture = null;
        if (sheet) setTimeout(() => {
            if (sheet && !document.hasFocus()) send('lost', sheet.nonce);
        }, 0);
    });
    window.addEventListener('pagehide', () => {
        if (sheet) send('lost', sheet.nonce);
        gesture = null;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.tabSwitcherInline) return;
        if (changes.tabSwitcherInline.newValue !== true) deactivate();
    });

    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (sender.id !== chrome.runtime.id || message?.type !== type) return;
        if (message.action === 'off') {
            deactivate();
            return;
        }
        if (typeof message.nonce !== 'string') return;
        const { action, nonce, pressedAt, page } = message;
        if (action === 'close') {
            hide(nonce);
            respond(true);
        } else if (enabled && action === 'probe' && gesture && !gesture.used && !gesture.ambiguous &&
            document.hasFocus() && !document.hidden && !['IFRAME', 'FRAME'].includes(document.activeElement?.tagName) &&
            gesture.started <= pressedAt && (!gesture.ended || Date.now() - gesture.ended <= releaseFreshMs)) {
            gesture.used = true;
            watch = { nonce, focus: document.activeElement };
            send(gesture.ended ? 'released-probe' : 'probe', nonce);
            respond(true);
        } else if (action === 'previewHint' && watch?.nonce === nonce) {
            watch.previewHint = message.visible === true;
            respond(true);
        } else if (action === 'armed' && watch?.nonce === nonce) {
            watch.open = true;
            respond(true);
        } else if (action === 'show' && sheet?.nonce === nonce && sheet.host.isConnected &&
            (sheet.search || document.hasFocus())) {
            if (watch?.nonce === nonce) watch.open = true;
            sheet.frame.style.visibility = 'visible';
            if (sheet.search) {
                sheet.focus = document.activeElement;
                sheet.frame.focus({ preventScroll: true });
            }
            respond(true);
        } else if (action === 'confirm-route') {
            const owns = mounting === nonce || sheet?.nonce === nonce;
            respond(Boolean(enabled && owns && window.top === window && document.visibilityState === 'visible' &&
                location.href === message.url));
        } else if (action === 'mount' && enabled && window.top === window && !document.fullscreenElement) {
            mounting = nonce;
            send('host', nonce).then(response => {
                if (response?.success && mounting === nonce) mount(nonce, page);
            }).finally(() => { if (mounting === nonce) mounting = null; });
            respond(true);
        }
    });
})();
