// Capture the release as soon as the picker document begins loading.
window.addEventListener('keyup', event => {
    if (!event.isTrusted || event.key !== 'Alt' || event.altKey) return;
    chrome.runtime.sendMessage({ type: 'openTabSwitcher', action: 'commit' }).catch(() => {});
}, { capture: true });
