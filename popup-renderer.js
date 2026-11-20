const INLINE_MESSAGE = 'recent-tabs-inline';

export function validPopupToken(value) {
    return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}

export function connectPopupFrame(start) {
    let connected = false;
    window.addEventListener('message', async event => {
        const { type, nonce } = event.data ?? {};
        if (connected || event.source !== window.parent || type !== INLINE_MESSAGE || !validPopupToken(nonce)) return;
        const send = (action, details) => chrome.runtime.sendMessage({ type, action, nonce, details }).catch(() => null);
        const response = await send('renderer');
        if (connected || !validPopupToken(response?.token)) return;
        connected = true;
        start(response, send);
    });
}
