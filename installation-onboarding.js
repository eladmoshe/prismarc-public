import { readBookmarkSpaces } from './onboarding-bookmarks.js';
import { watchAppearance } from './space-client.js';
import { usesOptionShortcut } from './tab-switcher-tabs.js';

const el = id => document.getElementById(id);
const lessons = [...document.querySelectorAll('[data-guide-step]')];
const progressDots = [...el('guide-dots').children];
const replay = new URLSearchParams(location.search).get('replay') === '1';
let lessonIndex = 0;
let windowId;
let bookmarkFolderId;
let shortcutRevision = 0;
let bookmarkRevision = 0;
let openedShortcutSettings = false;
let completing = false;

function showError(message) {
    el('error').textContent = message;
    el('error').hidden = false;
}

function focusHeading(container) {
    window.scrollTo(0, 0);
    container.querySelector('h1').focus({ preventScroll: true });
}

function showLesson(index) {
    const lesson = lessons[index];
    if (!lesson) return;
    lessonIndex = index;
    lessons.forEach(panel => { panel.hidden = panel !== lesson; });
    progressDots.forEach((dot, position) => dot.classList.toggle('current', position <= index));
    el('guide-progress').textContent = `Step ${index + 1} of ${lessons.length}`;
    const first = index === 0;
    const last = index === lessons.length - 1;
    const next = el('guide-next');
    el('guide-back').hidden = first;
    next.hidden = last;
    next.textContent = first ? 'Continue' : 'Next';
    next.classList.toggle('text-button', first);
    next.classList.toggle('primary', !first);
    el('guide-finish').hidden = !last;
    el('error').hidden = true;
    focusHeading(lesson);
}

function setOptionalSetup(open) {
    const settings = el('optional-settings');
    settings.hidden = !open;
    el('guide-lessons').hidden = open;
    el('error').hidden = true;
    if (open) {
        focusHeading(settings);
        loadBookmarkSpaces();
    } else {
        window.scrollTo(0, 0);
        el('optional-setup').focus({ preventScroll: true });
    }
}

function openSettings(url, error) {
    el('error').hidden = true;
    chrome.tabs.create({ url }).catch(() => showError(error));
}

async function openShortcutSettings() {
    el('error').hidden = true;
    try {
        await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        openedShortcutSettings = true;
    } catch {
        showError('Could not open keyboard shortcut settings. Enter chrome://extensions/shortcuts in the address bar.');
    }
}

function openSidebar() {
    el('error').hidden = true;
    // Chrome requires the call to run directly in the click gesture.
    chrome.sidePanel.open({ windowId }).catch(() => showError('Click the PrismArc toolbar icon to open the sidebar.'));
}

async function openQuickSwitcher() {
    el('error').hidden = true;
    try {
        const response = await chrome.runtime.sendMessage({ action: 'openQuickSwitcher', windowId });
        if (response?.success && response.handled === true) return;
    } catch { /* Show the same recovery hint if the worker cannot reply. */ }
    showError('Could not open Quick Switcher. Return to this Chrome window and try again, or use the search button in the sidebar.');
}

async function completeGuide() {
    if (completing) return;
    completing = true;
    el('error').hidden = true;
    try {
        if (!replay) {
            await chrome.storage.local.set({
                onboardingCompleted: true,
                onboardingVersion: chrome.runtime.getManifest().version
            });
        }
        el('guide-lessons').hidden = true;
        el('optional-settings').hidden = true;
        el('skip').hidden = true;
        const complete = el('guide-complete');
        complete.hidden = false;
        focusHeading(complete);
    } catch {
        showError('Could not save your guide progress. Try again.');
    } finally {
        completing = false;
    }
}

function showShortcut(id, binding) {
    const value = el(`${id}-shortcut`);
    value.textContent = binding || 'Not assigned';
    value.classList.toggle('shortcut-missing', !binding);
}

function showSwitcherSetup(ready) {
    el('quick-title').textContent = ready ? 'Test your shortcuts' : 'Set up your shortcuts';
    el('quick-task').textContent = ready
        ? 'Open a second tab if needed, then press both shortcuts. Change either one if it doesn’t work.'
        : 'PrismArc needs these keys for keyboard search and switching.';
    el('shortcut-directions').hidden = ready;

    const settings = el('setup-quick-shortcut');
    const tryQuick = el('open-quick-switcher');
    settings.textContent = ready ? 'Change shortcuts' : 'Open Chrome shortcut settings';
    settings.classList.toggle('primary', !ready);
    settings.classList.toggle('text-button', ready);
    tryQuick.classList.toggle('primary', ready);
    tryQuick.classList.toggle('text-button', !ready);
    const actions = el('quick-actions');
    const primary = ready ? tryQuick : settings;
    if (actions.firstElementChild !== primary) actions.prepend(primary);
}

function recentInstructions(commands, binding, mac) {
    if (!binding) {
        return `Assign ${mac ? 'Option+A' : 'Ctrl+Shift+Y'} to “Cycle through open tabs” in Chrome.`;
    }
    if (!mac || !usesOptionShortcut(commands)) {
        return 'Press your shortcut, then use the arrow keys and Enter to switch.';
    }
    const release = ' Release Option to switch, or press Enter if the picker stays open.';
    const simpleOption = binding.trim().match(/^(?:⌥|Alt|Option)\s*\+?\s*([A-Z0-9]|Tab|⇥)$/i);
    if (simpleOption) {
        const key = /^(?:Tab|⇥)$/i.test(simpleOption[1]) ? 'Tab' : simpleOption[1].toUpperCase();
        return `Tap Option+${key} for the previous tab. To cycle, hold Option and press ${key} again.` + release;
    }
    return 'Press your shortcut for the previous tab. To cycle, hold Option and repeat the shortcut.' + release;
}

function showShortcutReturnStatus(message) {
    const status = el('shortcut-return-status');
    if (status.textContent !== message) status.textContent = message;
}

async function loadShortcuts() {
    const revision = ++shortcutRevision;
    try {
        const [commands, platform] = await Promise.all([chrome.commands.getAll(), chrome.runtime.getPlatformInfo()]);
        if (revision !== shortcutRevision) return;
        const mac = platform.os === 'mac';
        const shortcut = name => commands.find(command => command.name === name)?.shortcut;
        const quick = shortcut('mockQuickSwitcher');
        const recent = shortcut('cycleOpenTabs');
        const sidebar = shortcut('_execute_action');
        const pin = shortcut('quickPinToggle');
        const copy = shortcut('copyCurrentUrl');
        showShortcut('quick', quick);
        showShortcut('recent-setup', recent);
        showShortcut('recent', recent);
        showShortcut('sidebar', sidebar);
        showShortcut('pin', pin);
        showShortcut('copy', copy);

        el('quick-suggestion').textContent = mac ? '⌘⇧K' : 'Ctrl+Shift+K';
        el('recent-suggestion').textContent = mac ? '⌥A' : 'Ctrl+Shift+Y';
        el('quick-setup-note').hidden = Boolean(quick);
        el('recent-setup-note').hidden = Boolean(recent);
        el('recent-mac-help').hidden = !mac;
        const ready = Boolean(quick && recent);
        showSwitcherSetup(ready);
        el('setup-sidebar-shortcut').hidden = Boolean(sidebar);
        el('setup-pin-shortcut').hidden = Boolean(pin);
        const copyButton = el('setup-copy-shortcut');
        copyButton.textContent = copy ? 'Change shortcut' : mac ? 'Set up ⌘⇧C' : 'Set up Ctrl+Shift+C';
        copyButton.disabled = false;

        el('recent-instructions').textContent = recentInstructions(commands, recent, mac);
        if (openedShortcutSettings) {
            const assigned = Number(Boolean(quick)) + Number(Boolean(recent));
            showShortcutReturnStatus(ready ? 'Both shortcuts assigned.' : `${assigned} of 2 shortcuts assigned.`);
        } else {
            showShortcutReturnStatus('');
        }
    } catch {
        if (revision !== shortcutRevision) return;
        for (const id of ['quick', 'recent-setup', 'recent', 'sidebar', 'pin', 'copy']) showShortcut(id, 'Unavailable');
        for (const id of ['quick-setup-note', 'recent-setup-note', 'recent-mac-help']) el(id).hidden = true;
        showSwitcherSetup(false);
        for (const button of document.querySelectorAll('.shortcut-settings')) button.hidden = button.disabled = false;
        el('setup-copy-shortcut').textContent = 'Shortcut settings';
        showShortcutReturnStatus('Couldn’t read your shortcuts. Check them in Chrome.');
        el('recent-instructions').textContent = 'Check this shortcut in Chrome.';
    }
}

async function loadBookmarkSpaces() {
    const revision = ++bookmarkRevision;
    let names = [];
    let folderId;
    try {
        ({ folderId, names } = await readBookmarkSpaces());
    } catch { /* The bookmark manager can still be opened without discovery. */ }
    if (revision !== bookmarkRevision) return;
    bookmarkFolderId = folderId;
    el('bookmark-title').textContent = names.length ? `Found ${names.length} existing ${names.length === 1 ? 'Space' : 'Spaces'}` : 'Import bookmarks';
    el('bookmark-copy').textContent = folderId
        ? 'Copy bookmark folders into PrismArc. Each folder becomes a Space and its bookmarks become pins.'
        : 'Open the sidebar once, then copy bookmark folders into PrismArc.';
    el('bookmark-detected').hidden = !names.length;
    el('bookmark-detected').textContent = names.slice(0, 3).join(' · ') + (names.length > 3 ? ` · and ${names.length - 3} more` : '');
    el('bookmarks').textContent = folderId ? 'Open PrismArc bookmarks' : 'Open bookmark manager';
}

const previewCards = [...el('recent-preview').querySelectorAll('li')];
let previewIndex = 0;

el('recent-preview-next').addEventListener('click', () => {
    previewIndex = (previewIndex + 1) % previewCards.length;
    previewCards.forEach((card, index) => { card.dataset.selected = String(index === previewIndex); });
    el('recent-preview-switch').disabled = false;
    el('recent-preview-status').textContent = `Selected ${previewCards[previewIndex].querySelector('strong').textContent}.`;
});

el('recent-preview-switch').addEventListener('click', () => {
    previewCards.forEach(card => {
        card.removeAttribute('aria-current');
        card.dataset.selected = 'false';
    });
    const active = previewCards[previewIndex];
    active.setAttribute('aria-current', 'true');
    el('recent-preview-status').textContent = `Switched to ${active.querySelector('strong').textContent}.`;
    el('recent-preview-next').focus();
    el('recent-preview-switch').disabled = true;
});

const pinExampleTab = el('pin-example-tab');
const pinDropZones = [...document.querySelectorAll('[data-pin-drop]')];
let draggingPinExample = false;

function movePinExample(destination) {
    const section = el(`pin-preview-${destination}`);
    if (pinExampleTab.parentElement === section) return;
    section.append(pinExampleTab);
    const pinned = destination === 'saved';
    el('pin-preview-toggle').textContent = pinned ? 'Unpin sample tab' : 'Pin sample tab';
    el('pin-preview-status').textContent = pinned ? 'Project plan is pinned.' : 'Project plan is back in Open tabs.';
}

el('pin-preview-toggle').addEventListener('click', () => {
    movePinExample(pinExampleTab.parentElement.id === 'pin-preview-open' ? 'saved' : 'open');
});

pinExampleTab.addEventListener('dragstart', event => {
    draggingPinExample = true;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', 'Project plan');
});
function endPinDrag() {
    draggingPinExample = false;
    for (const zone of pinDropZones) zone.classList.remove('drag-target');
}
pinExampleTab.addEventListener('dragend', endPinDrag);
for (const zone of pinDropZones) {
    zone.addEventListener('dragover', event => {
        if (!draggingPinExample) return;
        event.preventDefault();
        for (const target of pinDropZones) target.classList.toggle('drag-target', target === zone);
    });
    zone.addEventListener('drop', event => {
        if (!draggingPinExample) return;
        event.preventDefault();
        endPinDrag();
        movePinExample(zone.dataset.pinDrop);
    });
}

el('guide-next').addEventListener('click', () => showLesson(lessonIndex + 1));
el('guide-back').addEventListener('click', () => showLesson(lessonIndex - 1));
el('optional-setup').addEventListener('click', () => setOptionalSetup(true));
el('optional-back').addEventListener('click', () => setOptionalSetup(false));
el('guide-finish').addEventListener('click', completeGuide);
el('skip').addEventListener('click', completeGuide);
el('open-quick-switcher').addEventListener('click', openQuickSwitcher);
el('open-sidebar').addEventListener('click', openSidebar);
el('complete-open-sidebar').addEventListener('click', openSidebar);
for (const button of document.querySelectorAll('.shortcut-settings')) {
    button.addEventListener('click', openShortcutSettings);
}
el('appearance').addEventListener('click', () => openSettings('chrome://settings/appearance', 'Could not open Chrome’s Appearance settings.'));
el('bookmarks').addEventListener('click', () => openSettings(
    bookmarkFolderId ? `chrome://bookmarks/?id=${encodeURIComponent(bookmarkFolderId)}` : 'chrome://bookmarks/',
    'Could not open Chrome’s bookmark manager.'
));

function refreshSettings() {
    loadShortcuts();
    if (!el('optional-settings').hidden) loadBookmarkSpaces();
}

async function initialize() {
    refreshSettings();
    try {
        const tab = await chrome.tabs.getCurrent();
        if (!Number.isInteger(tab?.windowId)) return;
        windowId = tab.windowId;
        el('open-sidebar').disabled = el('complete-open-sidebar').disabled = false;
        watchAppearance(tab.windowId, tab.id);
        // Chrome may keep focus in its address bar when the guide tab is reactivated.
        chrome.tabs.onActivated.addListener(({ tabId }) => {
            if (tabId === tab.id) refreshSettings();
        });
    } catch { /* The four lessons and their previews remain usable. */ }
}

window.addEventListener('focus', refreshSettings);
initialize();
