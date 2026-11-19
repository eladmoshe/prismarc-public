let activeMenu;

// Start tracking dismissal before the caller looks up bookmark and folder data.
export function beginSidebarContextMenu(trigger) {
    activeMenu?.close();
    const document = trigger.ownerDocument;
    const window = document.defaultView;
    const listeners = new AbortController();
    const { signal } = listeners;
    let element;
    const observer = new MutationObserver(() => {
        if (!trigger.isConnected || (element && !element.isConnected)) close();
    });

    function close(restoreFocus = false) {
        if (signal.aborted) return;
        listeners.abort();
        observer.disconnect();
        element?.remove();
        activeMenu = undefined;
        if (restoreFocus && trigger.isConnected) {
            if (!trigger.hasAttribute('tabindex') && trigger.tabIndex < 0) trigger.tabIndex = -1;
            trigger.focus({ preventScroll: true });
        }
    }

    const session = {
        close,
        open(menu) {
            if (signal.aborted || !trigger.isConnected) {
                close();
                return false;
            }
            element = menu;
            document.body.appendChild(menu);
            return true;
        },
    };
    activeMenu = session;

    function dismissOutside(event) {
        if (!element?.contains(event.target)) close();
    }
    const capture = { capture: true, signal };
    document.addEventListener('pointerdown', dismissOutside, capture);
    document.addEventListener('click', dismissOutside, capture);
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        const focused = document.activeElement;
        const restore = focused === document.body || trigger.contains(focused) || Boolean(element?.contains(focused));
        if (restore) {
            event.preventDefault();
            event.stopPropagation();
        }
        close(restore);
    }, capture);
    window.addEventListener('blur', () => close(), { signal });
    observer.observe(document.body, { childList: true, subtree: true });
    return session;
}
