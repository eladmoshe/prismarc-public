export const TAB_FOCUS_TIMES = 'openTabFocusTimes';

export function usesOptionShortcut(commands) {
    const shortcut = commands.find(command => command.name === 'cycleOpenTabs')?.shortcut ?? '';
    return shortcut.includes('⌥') || /(?:^|\+)(?:Alt|Option)(?:\+|$)/i.test(shortcut);
}

export function tabLastViewed(tab, focusTimes) {
    const native = Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : 0;
    const focused = focusTimes?.[tab.id];
    return Math.max(0, native, Number.isFinite(focused) ? focused : 0);
}

export async function recentOpenTabs(chromeApi, sourceTab, focusTimes = {}) {
    const [windows, times] = await Promise.all([
        chromeApi.windows.getAll({ windowTypes: ['normal'], populate: true }), focusTimes,
    ]);
    const incognito = Boolean(sourceTab.incognito);
    return windows
        .filter(window => window.type === 'normal' && Boolean(window.incognito) === incognito)
        .flatMap(window => window.tabs ?? [])
        .filter(tab => Number.isInteger(tab.id) && tab.id >= 0 && Boolean(tab.incognito) === incognito)
        .sort((left, right) => Number(right.id === sourceTab.id) - Number(left.id === sourceTab.id) ||
            tabLastViewed(right, times) - tabLastViewed(left, times) ||
            right.id - left.id);
}

export async function focusOpenTab(chromeApi, tabId) {
    const tab = await chromeApi.tabs.update(tabId, { active: true });
    await chromeApi.windows.update(tab.windowId, { focused: true });
    return tab;
}

function tabAddress(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        return '';
    }

    switch (url.protocol) {
        case 'blob:': {
            const origin = url.origin === 'null' ? '' : new URL(url.origin).host;
            return origin ? `Embedded document · ${origin}` : 'Embedded document';
        }
        case 'data:':
        case 'filesystem:':
            return 'Embedded document';
        case 'javascript:':
            return 'JavaScript URL';
        case 'view-source:':
            return 'Page source';
        case 'file:':
            return 'Local file';
        case 'http:':
        case 'https:':
            return url.host + (url.pathname === '/' ? '' : url.pathname);
        case 'chrome-extension:':
            return 'Browser extension';
        default:
            return url.host ? `${url.protocol}//${url.host}` : 'Browser page';
    }
}

export function describeOpenTab(tab) {
    const url = tab.url || tab.pendingUrl || '';
    const address = tabAddress(url);
    const title = tab.title?.trim();
    if (title && title !== url && !/^(?:blob|data|filesystem|javascript|view-source):/i.test(title)) {
        return { title, address };
    }
    return { title: address || 'Untitled tab', address: '' };
}
