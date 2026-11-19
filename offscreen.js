import { isTrustedExtensionMessage } from './message-security.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isTrustedExtensionMessage(message, sender, chrome)) return;
    if (message.target !== 'offscreen' || message.type !== 'copyToClipboard' || typeof message.text !== 'string') return;

    const textarea = document.createElement('textarea');
    try {
        textarea.value = message.text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '0';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        const success = document.execCommand('copy');
        sendResponse(success ? { success: true } : { success: false, error: 'Clipboard copy was rejected' });
    } catch {
        sendResponse({ success: false, error: 'Clipboard copy failed' });
    } finally {
        textarea.remove();
    }
});
