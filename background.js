import { registerBookmarkListeners } from './bookmark-events.js';
import { createCleanTabsHandler } from './clean-tabs-service.js';
import { enqueueBookmarkOperation } from './bookmark-writer.js';
import { isProtectedFavorite } from './favorite-safety.js';
import { LocalStorage } from './localstorage.js';
import { Logger } from './logger.js';
import { isTrustedExtensionMessage } from './message-security.js';
import { NativeFavorites } from './native-favorites.js';
import { toggleQuickSwitcher } from './quick-switcher-window.js';
import { SpaceStore, ownerOf } from './space-store.js';
import { TabSwitcher } from './tab-switcher.js';
import { TabSwitcherPreviews } from './tab-switcher-previews.js';
import { dispatchTourMessage } from './tour-state.js';
import { copyCurrentTabUrlWithFallback } from './url-copy.js';
import { Utils } from './utils.js';
import { registerZoomLaunchTabs } from './zoom-launch-tabs.js';

const AUTO_ARCHIVE_ALARM_NAME = 'autoArchiveTabsAlarm';
const TAB_ACTIVITY_STORAGE_KEY = 'tabLastActivity';
const TAB_ACTIVITY_SESSION_KEY = 'tabActivitySessionInitialized';
const ONBOARDING_VERSION_KEY = 'onboardingVersion';
// Chrome stores custom assignments by this manifest ID.
const QUICK_SWITCHER_COMMAND = 'mockQuickSwitcher';
let archiveSafetyRevision = 0;
const reviseArchiveSafety = () => { archiveSafetyRevision++; };

const spaceStore = new SpaceStore();
const favorites = new NativeFavorites();
const tabSwitcherPreviews = new TabSwitcherPreviews(chrome);
const tabSwitcher = new TabSwitcher(chrome, tabSwitcherPreviews);
registerBookmarkListeners();
for (const event of [chrome.bookmarks.onCreated, chrome.bookmarks.onMoved,
    chrome.bookmarks.onChanged, chrome.bookmarks.onRemoved]) {
    event?.addListener(reviseArchiveSafety);
}
favorites.install();
spaceStore.install();
const handleCleanTabs = createCleanTabsHandler(chrome, spaceStore);
tabSwitcherPreviews.register();
registerZoomLaunchTabs(chrome, () => Logger.warn('Could not update Zoom launch tab cleanup.'));

function respond(operation, sendResponse, context, mapFailure = () => ({})) {
    operation.then(
        result => sendResponse({ success: true, ...result }),
        error => {
            Logger.error(Logger.context(context), error);
            sendResponse({ success: false, ...mapFailure(error) });
        }
    );
    return true;
}

function messageError(error) {
    return { error: error?.message, code: error?.code };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isTrustedExtensionMessage(message, sender, chrome)) return;

    switch (message.type) {
        case 'cleanTabs':
            return handleCleanTabs(message, sender, sendResponse);
        case 'popupSpaceTheme':
            return respond(spaceStore.popupUsesLightTheme(message.windowId, message.tabId)
                .then(light => ({ light })), sendResponse, 'Could not load the popup theme.');
        case 'spaceStore':
            return respond(spaceStore.dispatch(message).then(spaces => ({ spaces })),
                sendResponse, 'Could not complete the space operation.', messageError);
        case 'bookmarkOrder':
            return respond(enqueueBookmarkOperation(message.operation), sendResponse, 'Could not save bookmark order.',
                error => ({ ...messageError(error), observedOrders: error.observedOrders, moved: error.moved }));
        case 'nativeFavorites':
            return respond(favorites.dispatch(message).then(tabs => ({ tabs })),
                sendResponse, 'Could not complete the Favorites operation.', messageError);
        case 'sidebarTour':
            return respond(dispatchTourMessage(message).then(state => ({ state })),
                sendResponse, 'Could not save the sidebar tour.', messageError);
    }

    const pickerOperation = tabSwitcher.receive(message, sender);
    if (pickerOperation) return respond(pickerOperation, sendResponse, 'Could not complete the tab picker action.');

    if (message.command === 'toggleSpacePin') {
        // The sending sidebar does not receive its own runtime message.
        chrome.runtime.sendMessage({ command: 'toggleSpacePin', tabId: message.tabId }).catch(Logger.error);
        return;
    }

    switch (message.action) {
        case 'openQuickSwitcher':
            return respond(toggleQuickSwitcher(chrome, sender.tab?.windowId ?? message.windowId),
                sendResponse, 'Could not open Quick Switcher.');
        case 'updateAutoArchiveSettings':
            return respond(setupAutoArchiveAlarm(), sendResponse, 'Could not update the auto-archive alarm.');
        case 'openNewTab':
            return respond(chrome.tabs.create({ url: message.url }).then(() => ({})), sendResponse, 'Could not open the tab.');
        case 'switchToTab':
            return respond((async () => {
                await chrome.tabs.update(message.tabId, { active: true });
                await chrome.windows.update(message.windowId, { focused: true });
            })(), sendResponse, 'Could not switch to the tab.');
        case 'searchTabs':
            return respond(searchTabs(message.query), sendResponse, 'Could not search open tabs.');
        case 'getRecentTabs':
            return respond(getRecentTabs(message.limit), sendResponse, 'Could not read recent tabs.');
        case 'searchBookmarks':
            return respond(chrome.bookmarks.search(message.query).then(bookmarks => ({ bookmarks: bookmarks.filter(b => b.url) })),
                sendResponse, 'Could not search bookmarks.');
        case 'activatePinnedTab':
            // Sidebar contexts already receive the original runtime message.
            sendResponse({ success: true });
            return false;
    }
});

async function searchTabs(query) {
    const tabs = await chrome.tabs.query({});
    const text = query?.toLowerCase() || '';
    return { tabs: tabs.filter(tab => tab.title && tab.url &&
        (tab.title.toLowerCase().includes(text) || tab.url.toLowerCase().includes(text))) };
}

async function getRecentTabs(limit) {
    const [tabs, activity] = await Promise.all([
        chrome.tabs.query({}),
        enqueueActivityOperation(readTabActivity)
    ]);
    return { tabs: tabs
        .filter(tab => tab.url && tab.title)
        .map(tab => ({ ...tab, lastActivity: activity[tab.id] || 0 }))
        .sort((a, b) => b.lastActivity - a.lastActivity)
        .slice(0, limit || 5) };
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(Logger.error);
chrome.windows?.onRemoved?.addListener(() => tabSwitcher.removeWindow().catch(Logger.error));
chrome.windows?.onFocusChanged?.addListener(windowId => tabSwitcher.windowFocused(windowId).catch(Logger.error));

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    try {
        const { version } = chrome.runtime.getManifest();
        const settings = await chrome.storage.local.get(['onboardingCompleted', ONBOARDING_VERSION_KEY]);
        if ((reason === 'install' && !settings.onboardingCompleted) ||
            (reason === 'update' && settings[ONBOARDING_VERSION_KEY] !== version)) {
            await chrome.tabs.create({ url: 'installation-onboarding.html', active: true });
        }
    } catch (error) {
        Logger.error(Logger.context('Could not open the setup guide.'), error);
    }
});
chrome.runtime.onInstalled.addListener(refreshAutoArchiveAlarm);
chrome.runtime.onStartup.addListener(refreshAutoArchiveAlarm);
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('pinnedTabStatesById' in changes || 'arcifyBookmarkRootId' in changes) reviseArchiveSafety();
    if ('autoArchiveEnabled' in changes || 'autoArchiveIdleMinutes' in changes) {
        reviseArchiveSafety();
        return refreshAutoArchiveAlarm();
    }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
    try {
        switch (command) {
            case 'cycleOpenTabs':
                await tabSwitcher.invoke(tab);
                break;
            case QUICK_SWITCHER_COMMAND:
                await toggleQuickSwitcher(chrome, tab?.windowId);
                break;
            case 'quickPinToggle':
                await chrome.runtime.sendMessage({ command: 'quickPinToggle' });
                break;
            case 'NextTabInSpace':
            case 'PrevTabInSpace': {
                const activeTab = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
                if (!activeTab?.id) break;
                const space = ownerOf(await spaceStore.dispatch({ action: 'get', discoverBookmarks: false }), activeTab.id);
                if (!space) break;
                if (command === 'NextTabInSpace') await Utils.moveToNextTabInSpace(activeTab.id, space);
                else await Utils.moveToPrevTabInSpace(activeTab.id, space);
                break;
            }
            case 'copyCurrentUrl':
                await copyCurrentTabUrlWithFallback({ tab });
                break;
        }
    } catch (error) {
        Logger.error(Logger.context('Could not complete a keyboard command.'), error);
    }
});

let activityQueue = Promise.resolve();
let activitySessionReady = false;
const activityInFlight = new Map();
const unsavedActivity = new Map();

function enqueueActivityOperation(operation) {
    const pending = activityQueue.then(async () => {
        if (!activitySessionReady) {
            const session = await chrome.storage.session.get(TAB_ACTIVITY_SESSION_KEY);
            if (!session[TAB_ACTIVITY_SESSION_KEY]) {
                // A new Chrome session may reuse numeric IDs. Start timing
                // tabs again before any alarm or event can observe an old ID.
                await chrome.storage.local.set({ [TAB_ACTIVITY_STORAGE_KEY]: {} });
                await chrome.storage.session.set({ [TAB_ACTIVITY_SESSION_KEY]: true });
            }
            activitySessionReady = true;
        }
        return operation();
    });
    activityQueue = pending.catch(() => {});
    return pending;
}

async function readTabActivity() {
    const { [TAB_ACTIVITY_STORAGE_KEY]: activity = {} } = await chrome.storage.local.get(TAB_ACTIVITY_STORAGE_KEY);
    for (const [id, timestamp] of unsavedActivity) applyActivityChange(activity, id, timestamp);
    return activity;
}

function applyActivityChange(activity, tabId, timestamp) {
    if (timestamp === undefined) delete activity[tabId];
    else activity[tabId] = Math.max(activity[tabId] || 0, timestamp);
}

async function saveTabActivity(activity, changes) {
    try {
        await chrome.storage.local.set({ [TAB_ACTIVITY_STORAGE_KEY]: activity });
        unsavedActivity.clear();
    } catch (error) {
        for (const [id, timestamp] of changes) unsavedActivity.set(id, timestamp);
        throw error;
    }
}

function setTabActivity(tabId, timestamp) {
    if (!tabId) return;
    const update = { timestamp };
    activityInFlight.set(tabId, update);
    return enqueueActivityOperation(async () => {
        const activity = await readTabActivity();
        if (timestamp === undefined && !unsavedActivity.size && !Object.hasOwn(activity, tabId)) return;
        applyActivityChange(activity, tabId, timestamp);
        await saveTabActivity(activity, new Map([[tabId, timestamp]]));
    }).catch(error => {
        unsavedActivity.set(tabId, timestamp);
        Logger.error(Logger.context('Could not save tab activity.'), error);
    }).finally(() => {
        if (activityInFlight.get(tabId) === update) activityInFlight.delete(tabId);
    });
}

chrome.tabs.onActivated.addListener(info => {
    tabSwitcher.tabActivated(info);
    return setTabActivity(info.tabId, Date.now());
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if ((change.status === 'complete' || change.audible !== undefined) && (tab.active || tab.audible)) {
        return setTabActivity(tabId, Date.now());
    }
});
chrome.tabs.onRemoved.addListener(async tabId => {
    tabSwitcher.removeTab(tabId).catch(Logger.error);
    await setTabActivity(tabId);
    await Utils.removeTabNameOverride(tabId).catch(Logger.error);
});

async function setupAutoArchiveAlarm() {
    const settings = await Utils.getSettings();
    if (settings.autoArchiveEnabled && settings.autoArchiveIdleMinutes > 0) {
        await chrome.alarms.create(AUTO_ARCHIVE_ALARM_NAME, {
            periodInMinutes: Math.max(1, settings.autoArchiveIdleMinutes / 2)
        });
    } else {
        await chrome.alarms.clear(AUTO_ARCHIVE_ALARM_NAME);
    }
}

function refreshAutoArchiveAlarm() {
    return setupAutoArchiveAlarm().catch(error => Logger.error(Logger.context('Could not update the auto-archive alarm.'), error));
}

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name !== AUTO_ARCHIVE_ALARM_NAME) return;
    return enqueueActivityOperation(runAutoArchiveCheck)
        .catch(error => Logger.error(Logger.context('Could not check for idle tabs.'), error));
});

async function archivedFavoriteUrls() {
    const root = await LocalStorage.getArcifyFolder();
    if (!root) throw new Error('Bookmark root unavailable for auto-archive protection.');
    const [tree] = await chrome.bookmarks.getSubTree(root.id);
    if (!tree) throw new Error('Bookmark subtree unavailable for auto-archive protection.');
    const protectedUrlKeys = new Set();
    const nodes = [tree];
    while (nodes.length) {
        const node = nodes.pop();
        if (node.url) protectedUrlKeys.add(Utils.getPinnedUrlKey(node.url));
        for (const child of node.children || []) nodes.push(child);
    }
    return protectedUrlKeys;
}

function collectArchiveMembership(spaces) {
    const protectedIds = new Set();
    const spaceByTab = new Map();
    for (const space of spaces) {
        for (const id of space.spaceBookmarks) protectedIds.add(id);
        for (const id of space.temporaryTabs) spaceByTab.set(id, space.id);
    }
    return { protectedIds, spaceByTab };
}

function unchangedIdleTab(tab, url, idleBefore) {
    return tab?.url && tab.url === url && (!tab.pendingUrl || tab.pendingUrl === url)
        && tab.status !== 'loading' && !tab.active && !tab.audible && !tab.pinned && !tab.incognito
        && (!Number.isFinite(tab.lastAccessed) || tab.lastAccessed < idleBefore)
        && !activityInFlight.has(tab.id);
}

async function runAutoArchiveCheck() {
    const revision = archiveSafetyRevision;
    const settings = await Utils.getSettings();
    if (!settings.autoArchiveEnabled || settings.autoArchiveIdleMinutes <= 0) return;
    const now = Date.now();
    const idleBefore = now - settings.autoArchiveIdleMinutes * 60 * 1000;
    const [activity, tabs] = await Promise.all([
        readTabActivity(),
        chrome.tabs.query({ pinned: false })
    ]);
    const changes = new Map();
    const recordActivity = (id, timestamp) => {
        applyActivityChange(activity, id, timestamp);
        changes.set(id, timestamp);
    };
    try {
        const idleTabs = [];
        for (const tab of tabs) {
            if (!tab.id || tab.incognito || activityInFlight.has(tab.id)) continue;
            if (tab.active || tab.audible || !activity[tab.id]) {
                recordActivity(tab.id, now);
            } else if (activity[tab.id] < idleBefore && unchangedIdleTab(tab, tab.url, idleBefore)) {
                idleTabs.push(tab);
            }
        }
        if (!idleTabs.length) return;
        const spaces = await spaceStore.dispatch({ action: 'get', discoverBookmarks: false });
        const { protectedIds, spaceByTab } = collectArchiveMembership(spaces);
        const [bindings, protectedUrlKeys] = await Promise.all([Utils.getPinnedTabStates(), archivedFavoriteUrls()]);
        if (revision !== archiveSafetyRevision) return;
        const candidates = [];
        for (const tab of idleTabs) {
            if (isProtectedFavorite(tab, protectedIds, bindings, protectedUrlKeys)) {
                recordActivity(tab.id, now);
            } else if (spaceByTab.has(tab.id)) {
                candidates.push({ id: tab.id, url: tab.url, name: tab.title || tab.url, spaceId: spaceByTab.get(tab.id) });
            }
        }
        if (!candidates.length) return;
        await Utils.archiveTabs(candidates, (staged, markClosed) => spaceStore.run(async () => {
            // Wait for membership writes queued during save, then protect that
            // model while removing tabs. Bookmark and settings changes can
            // still arrive independently and invalidate this pass.
            const current = collectArchiveMembership(spaceStore.spaces);
            for (const candidate of staged) {
                if (revision !== archiveSafetyRevision) return;
                const { id, url, spaceId } = candidate;
                if (current.spaceByTab.get(id) !== spaceId || current.protectedIds.has(id)) continue;
                const latest = await chrome.tabs.get(id).catch(() => null);
                if (revision !== archiveSafetyRevision || !unchangedIdleTab(latest, url, idleBefore)) continue;
                try {
                    await chrome.tabs.remove(id);
                    markClosed(candidate);
                    recordActivity(id, undefined);
                } catch (error) {
                    Logger.warn(Logger.context('Could not close an archived tab.'), error);
                }
            }
        }));
    } finally {
        if (changes.size || unsavedActivity.size) await saveTabActivity(activity, changes);
    }
}
