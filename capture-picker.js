/*! Element selection adapted from DivPic, Copyright (c) 2026 rainDelay9 (MIT). See NOTICE. */
// Installed on demand in Chrome's isolated world in the authorized top document.
(() => {
    const stateKey = '__prismArcCapturePicker';
    const previous = globalThis[stateKey];
    if (previous?.listening) return;
    previous?.dismiss();

    const state = { listening: true, dismiss: () => {} };
    globalThis[stateKey] = state;
    let picker;
    let token;
    let theme;
    const startTimeout = setTimeout(() => cancel(false), 10_000);

    function dispose() {
        clearTimeout(startTimeout);
        if (state.listening) {
            try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* The extension may have reloaded. */ }
        }
        state.listening = false;
        picker?.remove();
        picker = undefined;
    }

    function clearState() {
        state.dismiss();
        if (globalThis[stateKey] === state) delete globalThis[stateKey];
    }

    function sendCancellation() {
        if (!token) return;
        try { chrome.runtime.sendMessage({ type: 'elementCaptureCancel', token }).catch(() => {}); } catch { /* The extension may have reloaded. */ }
    }

    function cancel(notify = true) {
        dispose();
        clearState();
        if (notify) sendCancellation();
    }

    function onMessage(message, sender, respond) {
        if (message?.type !== 'elementCapturePicker' || sender?.id !== chrome.runtime.id) return;
        if (sender.url && !sender.url.startsWith(chrome.runtime.getURL(''))) return;
        if (typeof message.token !== 'string' || !message.token) return;
        if (message.action === 'cancel' && (!picker || token === message.token)) {
            cancel(false);
            respond({ success: true });
        } else if (message.action === 'start') {
            if (!picker && document.documentElement && document.visibilityState === 'visible') {
                clearTimeout(startTimeout);
                token = message.token;
                theme = message.theme === 'dark' ? 'dark' : 'light';
                const messageText = unavailableMessage();
                if (messageText) {
                    dispose();
                    feedback(messageText, 4000);
                    respond({ success: false, feedbackShown: true });
                    return;
                } else {
                    picker = mountPicker();
                }
            }
            respond({ success: Boolean(picker && token === message.token) });
        }
    }

    function unavailableMessage() {
        if (document.contentType === 'application/pdf') return 'Screenshots are unavailable in Chrome’s PDF viewer';
        if (navigator.clipboard?.write && typeof ClipboardItem === 'function') return '';
        if (!window.isSecureContext) return 'Open an HTTPS page to copy screenshots';
        return 'Screenshot clipboard access is unavailable';
    }

    function createLayer(kind, css) {
        const dark = theme === 'dark';
        const host = document.createElement('div');
        host.setAttribute(`data-prismarc-capture-${kind}`, '');
        host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;margin:0!important;' +
            'display:block!important;overflow:hidden!important;pointer-events:none!important;z-index:2147483647!important';
        const root = host.attachShadow({ mode: 'closed' });
        const sheet = new CSSStyleSheet();
        // Constructed CSS works inside the shadow root without inserting an inline <style> into the page.
        sheet.replaceSync(`
            :host::backdrop { background: transparent; pointer-events: none; }
            .chip {
                box-sizing: border-box; position: fixed; pointer-events: none; padding: 6px 9px;
                color: ${dark ? '#f4f1f7' : '#222c46'}; background: ${dark ? '#29292e' : '#eff1fc'};
                border: 1px solid ${dark ? '#45414b' : '#68789b54'}; border-radius: 9px;
                box-shadow: 0 2px 10px #0002;
                font: 500 12px/1.35 system-ui, sans-serif;
            }
            .notice { inset: auto 0 16px; width: max-content; max-width: calc(100% - 24px); margin-inline: auto; text-align: center; }
            ${css}
        `);
        root.adoptedStyleSheets = [sheet];
        return { host, root };
    }

    function showLayer(host) {
        if (typeof host.showPopover === 'function') host.popover = 'manual';
        document.documentElement.append(host);
        if (!host.popover) return;
        try { host.showPopover(); } catch { host.removeAttribute('popover'); }
    }

    function node(className) {
        const element = document.createElement('div');
        element.className = className;
        return element;
    }

    function captureAccent() {
        return theme === 'dark' ? '#c5a9ed' : '#485fad';
    }

    function viewportSize() {
        const viewport = document.compatMode === 'BackCompat' ? document.body : document.documentElement;
        const { clientWidth, clientHeight } = viewport || document.documentElement;
        return { width: clientWidth || innerWidth, height: clientHeight || innerHeight };
    }

    function visibleRect(bounds) {
        const { width, height } = viewportSize();
        const x = Math.max(0, bounds.left);
        const y = Math.max(0, bounds.top);
        return {
            x, y,
            width: Math.max(0, Math.min(width, bounds.right) - x),
            height: Math.max(0, Math.min(height, bounds.bottom) - y),
        };
    }

    function usable(rect) {
        return rect && rect.width >= 2 && rect.height >= 2;
    }

    function mountPicker() {
        const accent = captureAccent();
        const { host, root } = createLayer('picker', `
            .catcher { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; touch-action: none; outline: none; }
            .selection { position: fixed; inset: 0; pointer-events: none; container-type: inline-size; }
            .dim { position: absolute; inset: 0; background: #0d0c143d; }
            .selected .dim {
                clip-path: polygon(evenodd,
                    0 0, 100% 0, 100% 100%, 0 100%, 0 var(--top),
                    var(--left) var(--top), var(--right) var(--top), var(--right) var(--bottom),
                    var(--left) var(--bottom), var(--left) var(--top), 0 var(--top));
            }
            .selection:not(.selected) :is(.outline, .size) { display: none; }
            .outline {
                position: absolute; border-radius: 4px;
                inset: var(--top) calc(100% - var(--right)) calc(100% - var(--bottom)) var(--left);
                box-shadow: 0 0 0 1px #fff, 0 0 0 2px ${accent};
            }
            .outline.region { border-radius: 0; }
            .size {
                position: absolute; top: 0; left: 0;
                padding: 3px 6px; font-variant-numeric: tabular-nums; white-space: nowrap;
                transform: translate(clamp(4px, var(--left), calc(100cqw - 100% - 4px)), var(--size-top));
            }
            @media (prefers-reduced-motion: no-preference) {
                .selection.moving { --motion: 120ms cubic-bezier(.2, .7, .3, 1); }
                .moving .dim { transition: clip-path var(--motion); }
                .moving .outline { transition: inset var(--motion); }
                .moving .size { transition: transform var(--motion); }
            }
            @media (forced-colors: active) {
                .dim { background: transparent; }
                .outline { outline: 2px solid Highlight; }
            }
        `);
        const selection = node('selection');
        const dim = node('dim');
        const outline = node('outline');
        const size = node('chip size');
        const catcher = node('catcher');
        const hint = node('chip notice');
        const watchers = new AbortController();
        const options = { signal: watchers.signal };
        const captureOptions = { ...options, capture: true };
        const replaced = new Set(['img', 'svg', 'video', 'canvas', 'picture', 'iframe', 'embed', 'object', 'input', 'textarea', 'select', 'button']);
        const previousFocus = document.activeElement;
        const idleTimeout = 25_000;
        const activityInterval = 10_000;
        let pointer;
        let drag;
        let base;
        let target;
        let hoverFrame;
        let backgroundTimer;
        let renderedRect;
        let renderedRegion;
        const children = [];
        let confirming = false;
        let lastActivity = performance.now();
        let lastReport = lastActivity;
        let activityReport;
        let expiry = setTimeout(expire, idleTimeout);

        catcher.tabIndex = -1;
        catcher.setAttribute('role', 'group');
        catcher.setAttribute('aria-label', 'Screenshot selection');
        catcher.setAttribute('aria-describedby', 'capture-hint');
        hint.id = 'capture-hint';
        hint.textContent = 'Click or Enter to copy · Drag for an area · ↑ ↓ to refine · Esc to cancel';
        size.setAttribute('aria-hidden', 'true');
        selection.append(dim, outline, size);
        root.append(selection, catcher, hint);
        showLayer(host);

        const observer = new MutationObserver(() => {
            if (!host.isConnected) cancel();
        });
        observer.observe(document.documentElement, { childList: true });

        function expire() {
            const remaining = idleTimeout - (performance.now() - lastActivity);
            if (remaining > 0) expiry = setTimeout(expire, remaining);
            else cancel();
        }

        async function reportActivity() {
            activityReport = undefined;
            if (confirming) return;
            lastReport = performance.now();
            try {
                const reply = await chrome.runtime.sendMessage({ type: 'elementCaptureActivity', token });
                if (reply?.success) return;
            } catch { /* The document may have lost its capture session. */ }
            if (!confirming && !watchers.signal.aborted) cancel(false);
        }

        function markActivity() {
            lastActivity = performance.now();
            activityReport ??= setTimeout(reportActivity, Math.max(0, activityInterval - (lastActivity - lastReport)));
        }

        function meaningful(element) {
            while (element?.parentElement && element !== document.body) {
                const { width, height } = element.getBoundingClientRect();
                const { display } = getComputedStyle(element);
                const inline = (display === 'inline' || display === 'contents') && !replaced.has(element.localName);
                if (width >= 24 && height >= 16 && !inline) break;
                element = element.parentElement;
            }
            return element;
        }

        function targetFor(element) {
            return element === base && target?.isConnected ? target : meaningful(element);
        }

        function choose(element, candidate = targetFor(element)) {
            if (element === base && candidate === target) return;
            base = element;
            target = candidate;
            children.length = 0;
        }

        function hitAt(x, y) {
            return document.elementsFromPoint(x, y).find(element => element !== host && element.getRootNode() !== root);
        }

        function pickAt(x, y) {
            choose(hitAt(x, y));
        }

        function rectFor(element) {
            return element?.isConnected ? visibleRect(element.getBoundingClientRect()) : undefined;
        }

        function regionRect(start, point) {
            return visibleRect({
                left: Math.min(start.x, point.x), top: Math.min(start.y, point.y),
                right: Math.max(start.x, point.x), bottom: Math.max(start.y, point.y),
            });
        }

        function render(rect, { region = false, hover = false } = {}) {
            if (!hover) selection.classList.remove('moving');
            if (!usable(rect)) {
                selection.classList.remove('moving', 'selected');
                renderedRect = undefined;
                return;
            }
            if (renderedRect && rect.x === renderedRect.x && rect.y === renderedRect.y &&
                rect.width === renderedRect.width && rect.height === renderedRect.height && region === renderedRegion) return;

            selection.classList.toggle('moving', hover && Boolean(renderedRect));
            selection.classList.add('selected');
            outline.classList.toggle('region', region);
            selection.style.setProperty('--left', `${rect.x}px`);
            selection.style.setProperty('--top', `${rect.y}px`);
            selection.style.setProperty('--right', `${rect.x + rect.width}px`);
            selection.style.setProperty('--bottom', `${rect.y + rect.height}px`);
            selection.style.setProperty('--size-top', `${rect.y < 28 ? rect.y + 4 : rect.y - 28}px`);
            const dimensions = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
            if (size.textContent !== dimensions) size.textContent = dimensions;
            renderedRect = rect;
            renderedRegion = region;
        }

        function isBackgroundTarget(element, rect) {
            if (element === document.body || element === document.documentElement) return true;
            if (!rect || rect.x !== 0 || rect.y !== 0 || replaced.has(element.localName)) return false;
            const { width, height } = viewportSize();
            return rect.width === width && rect.height === height;
        }

        function renderHover() {
            hoverFrame = undefined;
            const element = hitAt(pointer.x, pointer.y);
            const candidate = targetFor(element);
            const rect = rectFor(candidate);
            if (renderedRect && candidate !== target && isBackgroundTarget(candidate, rect)) {
                // Keep the previous aperture when the pointer briefly crosses a page-sized gap.
                backgroundTimer ??= setTimeout(() => {
                    cancelHover();
                    pickAt(pointer.x, pointer.y);
                    render(rectFor(target), { hover: true });
                }, 75);
                return;
            }
            clearTimeout(backgroundTimer);
            backgroundTimer = undefined;
            choose(element, candidate);
            render(rect, { hover: true });
        }

        function cancelHover() {
            if (hoverFrame !== undefined) cancelAnimationFrame(hoverFrame);
            hoverFrame = undefined;
            clearTimeout(backgroundTimer);
            backgroundTimer = undefined;
        }

        function moveToParent() {
            const current = target?.getBoundingClientRect();
            if (!current) return;
            let parent = target.parentElement;
            while (parent && parent !== document.documentElement) {
                const bounds = parent.getBoundingClientRect();
                if (['left', 'top', 'width', 'height'].some(key => Math.abs(current[key] - bounds[key]) >= 1)) break;
                parent = parent.parentElement;
            }
            if (parent) {
                children.push(target);
                target = parent;
            }
        }

        function swallow(event) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }

        function onPointerDown(event) {
            swallow(event);
            if (!event.isTrusted || !event.isPrimary || event.button !== 0 || confirming) return;
            markActivity();
            pointer = { x: event.clientX, y: event.clientY };
            cancelHover();
            pickAt(pointer.x, pointer.y);
            render(rectFor(target));
            drag = { start: pointer, id: event.pointerId };
            catcher.setPointerCapture(event.pointerId);
        }

        function onPointerMove(event) {
            if (!event.isTrusted || !event.isPrimary || confirming) return;
            event.stopImmediatePropagation();
            markActivity();
            pointer = { x: event.clientX, y: event.clientY };
            if (drag) {
                drag.region ||= Math.hypot(pointer.x - drag.start.x, pointer.y - drag.start.y) > 4;
                if (drag.region) render(regionRect(drag.start, pointer), { region: true });
                return;
            }
            hoverFrame ??= requestAnimationFrame(renderHover);
        }

        function onPointerUp(event) {
            swallow(event);
            if (!event.isTrusted || event.button !== 0 || drag?.id !== event.pointerId || confirming) return;
            pointer = { x: event.clientX, y: event.clientY };
            const isRegion = drag.region || Math.hypot(pointer.x - drag.start.x, pointer.y - drag.start.y) > 4;
            const rect = isRegion ? regionRect(drag.start, pointer) : rectFor(target);
            drag = undefined;
            if (usable(rect)) {
                confirming = true;
                copy(rect, isRegion);
            } else {
                render(rectFor(target));
            }
        }

        function onKeyDown(event) {
            if (!event.isTrusted || !host.isConnected) return;
            if (event.key === 'Escape') {
                swallow(event);
                cancel();
                return;
            }
            if (document.activeElement !== host || event.ctrlKey || event.metaKey || event.altKey ||
                !['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return;
            swallow(event);
            if (drag || confirming) return;
            markActivity();
            if (hoverFrame !== undefined) {
                cancelAnimationFrame(hoverFrame);
                renderHover();
            }
            cancelHover();
            if (event.key === 'ArrowUp') moveToParent();
            if (event.key === 'ArrowDown' && children.length) target = children.pop();
            const rect = rectFor(target);
            if (event.key === 'Enter' && !event.repeat && usable(rect)) {
                confirming = true;
                copy(rect);
            } else {
                render(rect);
            }
        }

        function onViewportChange() {
            if (confirming) return;
            cancelHover();
            if (drag?.region) {
                render(regionRect(drag.start, pointer), { region: true });
                return;
            }
            if (pointer) pickAt(pointer.x, pointer.y);
            render(rectFor(target));
        }

        function stopDrag(event) {
            if (!event.isTrusted || drag?.id !== event.pointerId) return;
            drag = undefined;
            render(rectFor(target));
        }

        catcher.addEventListener('pointerdown', onPointerDown, options);
        catcher.addEventListener('pointermove', onPointerMove, options);
        catcher.addEventListener('pointerup', onPointerUp, options);
        catcher.addEventListener('pointercancel', stopDrag, options);
        catcher.addEventListener('lostpointercapture', stopDrag, options);
        for (const type of ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'dragstart']) {
            catcher.addEventListener(type, swallow, options);
        }
        catcher.addEventListener('contextmenu', event => {
            swallow(event);
            if (event.isTrusted) cancel();
        }, options);
        window.addEventListener('keydown', onKeyDown, captureOptions);
        window.addEventListener('scroll', onViewportChange, captureOptions);
        window.addEventListener('resize', onViewportChange, options);
        window.addEventListener('pagehide', () => cancel(), options);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') cancel();
        }, options);
        host.addEventListener('toggle', event => {
            if (event.newState === 'closed') cancel();
        }, options);

        if (previousFocus && previousFocus !== document.body && usable(visibleRect(previousFocus.getBoundingClientRect()))) {
            choose(previousFocus);
        } else {
            pickAt(innerWidth / 2, innerHeight / 2);
        }
        render(rectFor(target));
        catcher.focus({ preventScroll: true });

        return {
            remove() {
                watchers.abort();
                observer.disconnect();
                cancelHover();
                clearTimeout(expiry);
                clearTimeout(activityReport);
                const restoreFocus = document.activeElement === host;
                host.remove();
                if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
            },
        };
    }

    function nextPaint() {
        return new Promise((resolve, reject) => {
            let frame;
            const timeout = setTimeout(() => {
                cancelAnimationFrame(frame);
                reject(new Error('Page did not repaint'));
            }, 1000);
            frame = requestAnimationFrame(() => {
                frame = requestAnimationFrame(() => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
        });
    }

    function viewportMatches(viewport) {
        return viewport.width === innerWidth && viewport.height === innerHeight &&
            viewport.scrollX === scrollX && viewport.scrollY === scrollY;
    }

    async function requestImage(rect, viewport, signal) {
        const { width: viewportWidth, height: viewportHeight } = viewport;
        // Leave the catcher present through the click after pointerup, then let Chrome paint the page alone.
        await new Promise(resolve => setTimeout(resolve, 0));
        dispose();
        await nextPaint();
        if (signal.aborted || globalThis[stateKey] !== state || document.visibilityState !== 'visible' ||
            !viewportMatches(viewport)) {
            throw new Error('Selection is no longer visible');
        }
        const reply = await chrome.runtime.sendMessage({ type: 'elementCaptureSelection', token, rect, viewportWidth, viewportHeight });
        if (!reply?.success || typeof reply.png !== 'string') throw new Error('Screenshot unavailable');
        const binary = atob(reply.png);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: 'image/png' });
    }

    async function copy(rect, region = false) {
        const viewport = { width: innerWidth, height: innerHeight, scrollX, scrollY };
        const pending = new AbortController();
        try {
            // Starting the write now preserves the trusted pointer or keyboard activation while the PNG is prepared.
            const png = requestImage(rect, viewport, pending.signal);
            png.catch(() => {});
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        } catch {
            pending.abort();
            sendCancellation();
            // Keep suppressing the trailing click even if starting the clipboard write failed synchronously.
            await new Promise(resolve => setTimeout(resolve, 0));
            dispose();
            const message = document.featurePolicy?.allowsFeature('clipboard-write') === false
                ? 'This page blocks copying images. Use your device’s screenshot shortcut instead.'
                : 'Screenshot wasn’t copied. Keep this tab in front and select the area again.';
            feedback(message, 5000);
            return;
        }
        if (viewportMatches(viewport)) feedback('Copied', 1500, { rect, region });
        else feedback('Screenshot copied', 1500);
    }

    function copiedStyles(duration) {
        const accent = captureAccent();
        return `
            .copied-outline, .copied-stroke {
                box-sizing: border-box; position: fixed; pointer-events: none; border-radius: 4px;
                box-shadow: inset 0 0 0 1px #fff, inset 0 0 0 2px ${accent};
            }
            .copied-outline.region { border-radius: 0; }
            .copied {
                display: flex; align-items: center; gap: 7px; width: max-content; border-radius: 100px;
                max-width: calc(100% - 12px);
            }
            .copied-clipboard {
                position: relative; display: grid; place-items: center; flex: none;
                box-sizing: border-box; width: 14px; height: 16px; border: 1.5px solid currentColor;
                border-radius: 3px; color: ${accent};
            }
            .copied-clipboard::before {
                content: ''; position: absolute; width: 7px; height: 4px; top: -3px; left: 50%;
                transform: translateX(-50%); border-radius: 2px; background: currentColor;
            }
            .copied-check { font: 750 10px/1 system-ui, sans-serif; }
            .copied-stroke { display: none; }
            @keyframes prismarc-capture-confirm {
                84% { opacity: 1; }
                100% { opacity: 0; }
            }
            @keyframes prismarc-capture-lift {
                0% {
                    left: var(--source-x); top: var(--source-y); width: var(--source-width); height: var(--source-height);
                    border-radius: var(--source-radius); background-color: transparent;
                    animation-timing-function: cubic-bezier(.2, .65, .35, 1);
                }
                34% {
                    left: var(--lift-x); top: var(--lift-y); width: var(--lift-width); height: var(--lift-height);
                    border-radius: 5px; background-color: transparent;
                    animation-timing-function: cubic-bezier(.52, .04, .35, 1);
                }
                48%, 88% { background-color: ${theme === 'dark' ? '#342944' : '#e5e9fc'}; }
                92%, 100% {
                    left: var(--dock-x); top: var(--dock-y); width: 9px; height: 11px; border-radius: 2px;
                }
                88% { opacity: 1; }
                100% { opacity: 0; }
            }
            @keyframes prismarc-capture-fold {
                0%, 25%, 81%, 100% { opacity: 0; }
                39%, 64% { opacity: 1; }
            }
            @keyframes prismarc-capture-source {
                0% { opacity: 1; }
                100% { opacity: 0; }
            }
            @keyframes prismarc-capture-check {
                0%, 84% { opacity: 0; transform: scale(.55); }
                95% { opacity: 1; transform: scale(1.12); }
                100% { opacity: 1; transform: scale(1); }
            }
            @media (prefers-reduced-motion: no-preference) {
                .copied { animation: prismarc-capture-confirm ${duration}ms ease both; }
                .copied-outline { animation: prismarc-capture-source 140ms ease-out both; }
                .copied-stroke {
                    display: block; transform: translate(-50%, -50%);
                    animation: prismarc-capture-lift 470ms ease both;
                }
                .copied-stroke::after {
                    content: ''; position: absolute; right: 2px; top: 2px; width: 10px; height: 10px;
                    background: linear-gradient(45deg, ${accent} 50%, transparent 51%);
                    border-radius: 0 0 0 2px;
                    animation: prismarc-capture-fold 470ms ease both;
                }
                .copied-check { animation: prismarc-capture-check 510ms ease both; }
            }
            @media (forced-colors: active) {
                .copied-outline, .copied-stroke { border: 2px solid Highlight; }
                .copied-clipboard { color: ButtonText; }
                .copied-clipboard::before, .copied-stroke::after { forced-color-adjust: none; }
                .copied-stroke::after { background: linear-gradient(45deg, Highlight 50%, transparent 51%); }
            }
        `;
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), Math.max(min, max));
    }

    function showCopyConfirmation(root, notice, { rect, region }) {
        const clipboard = document.createElement('span');
        clipboard.className = 'copied-clipboard';
        clipboard.setAttribute('aria-hidden', 'true');
        const check = document.createElement('span');
        check.className = 'copied-check';
        check.textContent = '✓';
        clipboard.append(check);
        notice.prepend(clipboard);

        const { x, y, width, height } = rect;
        const viewport = viewportSize();
        const sourceX = x + width / 2;
        const sourceY = y + height / 2;
        const noticeWidth = notice.offsetWidth;
        const noticeHeight = notice.offsetHeight;
        const margin = 6;
        const gap = 12;
        const roomAbove = y - margin;
        const roomBelow = viewport.height - y - height - margin;
        // If the selection fills the viewport, use the nearest edge inside it.
        let noticeTop = y + height + gap;
        if (roomAbove >= noticeHeight + gap) {
            noticeTop = y - noticeHeight - gap;
        } else if (roomBelow < noticeHeight + gap) {
            noticeTop = roomAbove >= roomBelow ? y + gap : y + height - noticeHeight - gap;
        }
        notice.style.left = `${clamp(sourceX - noticeWidth / 2, margin, viewport.width - noticeWidth - margin)}px`;
        notice.style.top = `${clamp(noticeTop, margin, viewport.height - noticeHeight - margin)}px`;

        const outline = node(region ? 'copied-outline region' : 'copied-outline');
        outline.setAttribute('aria-hidden', 'true');
        Object.assign(outline.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });

        const icon = clipboard.getBoundingClientRect();
        const dockX = icon.left + icon.width / 2;
        const dockY = icon.top + icon.height / 2;
        const liftWidth = Math.min(clamp(width * .24, 32, 60), viewport.width);
        const liftHeight = Math.min(clamp(height * .24, 22, 38), viewport.height);
        const liftX = clamp(sourceX + (dockX < sourceX ? 18 : -18), liftWidth / 2, viewport.width - liftWidth / 2);
        const liftY = clamp(sourceY + (dockY < sourceY ? -15 : 15), liftHeight / 2, viewport.height - liftHeight / 2);

        const echo = node('copied-stroke');
        echo.setAttribute('aria-hidden', 'true');
        echo.style.cssText = `
            --source-x: ${sourceX}px; --source-y: ${sourceY}px; --source-width: ${width}px; --source-height: ${height}px;
            --source-radius: ${region ? 0 : 4}px;
            --lift-x: ${liftX}px; --lift-y: ${liftY}px; --lift-width: ${liftWidth}px; --lift-height: ${liftHeight}px;
            --dock-x: ${dockX}px; --dock-y: ${dockY}px;
        `;
        root.prepend(outline);
        root.append(echo);
    }

    function feedback(message, duration, selection) {
        if (globalThis[stateKey] !== state || document.visibilityState !== 'visible') return;
        const { host, root } = createLayer('feedback', selection ? copiedStyles(duration) : '');
        const notice = node(selection ? 'chip copied' : 'chip notice');
        notice.setAttribute('role', 'status');
        notice.textContent = message;
        root.append(notice);
        showLayer(host);
        if (selection) showCopyConfirmation(root, notice, selection);
        const watchers = new AbortController();
        const options = { signal: watchers.signal };
        window.addEventListener('pagehide', clearState, options);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') clearState();
        }, options);
        if (selection) {
            window.addEventListener('scroll', clearState, { ...options, capture: true });
            window.addEventListener('resize', clearState, options);
        }
        const expiry = setTimeout(clearState, duration);
        state.dismiss = () => {
            watchers.abort();
            clearTimeout(expiry);
            host.remove();
        };
    }

    chrome.runtime.onMessage.addListener(onMessage);
})();
