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
    el('guide-back').hidden = index === 0;
    const last = index === lessons.length - 1;
    el('guide-next').hidden = last;
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
    el(`${id}-shortcut`).textContent = binding || 'Not assigned';
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
        showShortcut('recent', recent);
        showShortcut('sidebar', sidebar);
        showShortcut('pin', pin);
        showShortcut('copy', copy);

        const usesCommandT = /^(?:⌘|Command|Cmd)\s*\+?\s*T$/i.test(quick?.trim() ?? '');
        el('quick-mac-note').hidden = !mac || usesCommandT;
        el('quick-setup-note').hidden = mac || Boolean(quick);
        el('setup-quick-shortcut').hidden = false;
        el('setup-sidebar-shortcut').hidden = Boolean(sidebar);
        el('setup-pin-shortcut').hidden = Boolean(pin);
        const copyButton = el('setup-copy-shortcut');
        copyButton.textContent = copy ? 'Change shortcut' : mac ? 'Set up ⌘⇧C' : 'Set up Ctrl+Shift+C';
        copyButton.disabled = false;

        const recentInstructions = el('recent-instructions');
        if (mac && usesOptionShortcut(commands)) {
            const optionTab = /^(?:⌥|Alt|Option)\s*\+?\s*(?:Tab|⇥)$/i.test(recent.trim());
            recentInstructions.textContent = optionTab
                ? 'Tap Option+Tab to return to the previous tab. To choose another, hold Option, tap Tab to move, then release Option.'
                : 'Press your shortcut and keep holding Option. Tap Tab to move, then release Option to switch.';
        } else if (recent) {
            recentInstructions.textContent = 'Press your shortcut to open the picker. Use the arrow keys to move and Enter to switch.';
            if (mac) recentInstructions.textContent += ' With Option+Tab assigned, hold Option, tap Tab, then release Option to switch.';
        } else {
            recentInstructions.textContent = mac
                ? 'Assign Option+Tab to “Cycle through open tabs” in extension shortcuts. Hold Option, tap Tab to move, and release Option to switch.'
                : 'Assign an available shortcut to “Cycle through open tabs” in extension shortcuts. In the picker, use the arrow keys and Enter.';
        }
    } catch {
        if (revision !== shortcutRevision) return;
        for (const id of ['quick', 'recent', 'sidebar', 'pin', 'copy']) el(`${id}-shortcut`).textContent = 'Unavailable';
        for (const button of document.querySelectorAll('.shortcut-settings')) button.hidden = button.disabled = false;
        el('recent-instructions').textContent = 'Check Chrome’s extension shortcuts for the current assignment.';
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
    el('bookmark-title').textContent = names.length ? `Found ${names.length} existing ${names.length === 1 ? 'Space' : 'Spaces'}` : 'Bring your bookmarks';
    el('bookmark-copy').textContent = folderId
        ? 'Copy folders into the PrismArc bookmark folder in Chrome’s bookmark manager. Each folder becomes a Space and its bookmarks become pinned tabs.'
        : 'Open the sidebar once to create the PrismArc bookmark folder. Then copy folders into it in Chrome’s bookmark manager.';
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
    button.addEventListener('click', () => openSettings('chrome://extensions/shortcuts', 'Could not open Chrome’s extension shortcuts.'));
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
