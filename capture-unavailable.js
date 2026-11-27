function screenshotHint() {
    if (/Mac/i.test(navigator.platform)) return 'Close this notice, then press Control + Command + Shift + 4 and drag to copy an area.';
    if (/Win/i.test(navigator.platform)) return 'Close this notice, then press Win + Shift + S and drag to copy an area.';
    return 'Use your system screenshot tool to copy an area.';
}

const messages = new Map([
    ['store', ['Chrome blocks element capture on the Chrome Web Store.', screenshotHint()]],
    ['protected', ['Chrome blocks element capture on this browser page.', screenshotHint()]],
    ['permission', ['Allow the element picker', 'PrismArc needs permission to show the picker on a page you choose.']],
    ['unavailable', ['Couldn’t open the element picker', 'Reload the page and try Capture element again.']],
]);

const reasonHeading = document.getElementById('reason');
const nextStep = document.getElementById('next-step');
const close = document.getElementById('close');
const allow = document.getElementById('allow');

function render() {
    const [reason, theme] = location.hash.slice(1).split('-');
    document.documentElement.dataset.appearance = theme === 'light' ? 'light' : 'dark';
    const [heading, hint] = messages.get(reason) ?? messages.get('unavailable');
    reasonHeading.textContent = heading;
    nextStep.textContent = hint;
    allow.hidden = reason !== 'permission';
}

async function closeNotice() {
    const tab = await chrome.tabs.getCurrent();
    if (tab) await chrome.tabs.remove(tab.id);
}

allow.addEventListener('click', async () => {
    const invocation = location.hash;
    allow.disabled = true;
    const granted = await chrome.permissions.request({ permissions: ['scripting'] }).catch(() => false);
    allow.disabled = false;
    if (location.hash !== invocation) return;
    if (granted) {
        reasonHeading.textContent = 'Element picker ready';
        nextStep.textContent = 'Close this notice, then try Capture element again.';
        allow.hidden = true;
        close.focus();
    } else {
        nextStep.textContent = 'Chrome didn’t grant access. Select Allow element picker to try again.';
        allow.focus();
    }
});
close.addEventListener('click', () => closeNotice().catch(() => {}));
window.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeNotice().catch(() => {});
});
window.addEventListener('hashchange', render);
render();
