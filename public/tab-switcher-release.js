// Capture the release as soon as the picker document begins loading.
window.addEventListener('keyup', event => {
    if (window.parent !== window || !event.isTrusted || event.key !== 'Alt' || event.altKey ||
        document.documentElement.hasAttribute('data-opening-preview-settings')) return;
    chrome.runtime.sendMessage({ type: 'openTabSwitcher', action: 'commit' }).catch(() => {});
}, { capture: true });
