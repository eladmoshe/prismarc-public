const maxRecords = 500;
const maxBytes = 1024 * 1024;
const maxRecordBytes = 8 * 1024;
const encoder = new TextEncoder();

export const restoreLifetime = 2 * 60 * 1000;

export function restoreUrl(tab) {
    const url = tab.pendingUrl || tab.url;
    if (url && !/^(chrome:\/\/(newtab|new-tab-page)\/?|about:blank)$/.test(url)) return url;
}

export function boundRestoreRecords(records) {
    let bytes = 2;
    const bounded = [];
    for (const record of records) {
        if (!record?.url || record.url.length > maxRecordBytes) continue;
        const size = encoder.encode(JSON.stringify(record)).byteLength + 1;
        if (size > maxRecordBytes || bytes + size > maxBytes) continue;
        bounded.push(record);
        bytes += size;
        if (bounded.length === maxRecords) break;
    }
    return bounded;
}

function groupBy(items, key) {
    const groups = new Map();
    for (const item of items) {
        const value = key(item);
        if (!groups.has(value)) groups.set(value, []);
        groups.get(value).push(item);
    }
    return groups;
}

// Native window IDs can change on browser restart. URLs that only occur once
// provide evidence linking an old window to a current window.
export function matchStartupRestores(records, tabs) {
    const savedByUrl = groupBy(records, record => record.url);
    const currentByUrl = groupBy(tabs.filter(tab => !tab.pinned && !tab.incognito && restoreUrl(tab)), restoreUrl);
    const matches = new Map();
    const anchors = [];
    for (const [url, current] of currentByUrl) {
        const saved = savedByUrl.get(url);
        if (saved?.length !== 1 || current.length !== 1) continue;
        const [record] = saved;
        const [tab] = current;
        matches.set(tab.id, record);
        if (Number.isInteger(record.windowId)) anchors.push({ old: record.windowId, current: tab.windowId });
    }
    const oldWindows = groupBy(anchors, pair => pair.old);
    const currentWindows = groupBy(anchors, pair => pair.current);
    function compatible(record, tab) {
        if (!Number.isInteger(record.index) || record.index !== tab.index) return false;
        const oldEvidence = oldWindows.get(record.windowId) || [];
        const newEvidence = currentWindows.get(tab.windowId) || [];
        return oldEvidence.every(pair => pair.current === tab.windowId)
            && newEvidence.every(pair => pair.old === record.windowId);
    }
    for (const [url, current] of currentByUrl) {
        const saved = savedByUrl.get(url);
        if (!saved?.length || (saved.length === 1 && current.length === 1)) continue;
        for (const tab of current) {
            const possible = saved.filter(record => compatible(record, tab));
            // Both sides must agree before transferring a space or bookmark binding.
            if (possible.length === 1 && current.filter(other => compatible(possible[0], other)).length === 1) {
                matches.set(tab.id, possible[0]);
            }
        }
    }
    return matches;
}
