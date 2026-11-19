import { CALENDAR_EVENTS_ENDPOINT } from './calendar-config.js';

export const HOUR = 60 * 60 * 1000;

export function getLocalCalendarDay(now = new Date()) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const date = [start.getFullYear(), start.getMonth() + 1, start.getDate()]
        .map(part => String(part).padStart(2, '0')).join('-');
    return { start, end, date, key: start.toISOString() };
}

function toPreviewEvent(event, day) {
    if (!event || event.status === 'cancelled') return null;
    const title = typeof event.summary === 'string' && event.summary.trim()
        ? event.summary.trim().slice(0, 300)
        : 'Untitled event';
    if (event.start?.date && event.end?.date) {
        return event.start.date <= day.date && event.end.date > day.date ? { title, allDay: true } : null;
    }
    const start = Date.parse(event.start?.dateTime);
    const end = Date.parse(event.end?.dateTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start ||
        end < +day.start || (end === +day.start && end !== start) || start >= +day.end) return null;
    return { title, start, end };
}

export function placeCalendarEvents(events, day) {
    const minHeight = HOUR / 3;
    const timed = events.filter(event => !event.allDay)
        .sort((left, right) => left.start - right.start || right.end - left.end);
    let lanes = [];
    let group = [];
    const placed = [];
    const completeGroup = () => {
        for (const event of group) placed.push({ ...event, columns: lanes.length });
        lanes = [];
        group = [];
    };
    for (const event of timed) {
        const start = Math.max(event.start, +day.start);
        const end = Math.min(Math.max(event.end, start + minHeight), +day.end);
        let column = lanes.findIndex(previousEnd => previousEnd <= start);
        if (lanes.length && lanes.every(previousEnd => previousEnd <= start)) {
            completeGroup();
            column = -1;
        }
        if (column === -1) column = lanes.length;
        lanes[column] = end;
        group.push({ ...event, column, top: (start - day.start) / HOUR, height: (end - start) / HOUR });
    }
    completeGroup();
    return placed;
}

export class CalendarAccessError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

async function readCalendarPage(response) {
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !response.body) {
        throw new CalendarAccessError('unavailable');
    }
    const limit = 1024 * 1024;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let json = '';
    try {
        for (let part = await reader.read(); !part.done; part = await reader.read()) {
            bytes += part.value.byteLength;
            if (bytes > limit) {
                await reader.cancel();
                throw new CalendarAccessError('unavailable');
            }
            json += decoder.decode(part.value, { stream: true });
        }
    } finally {
        reader.releaseLock();
    }
    const page = JSON.parse(json + decoder.decode());
    if (!page || typeof page !== 'object' || !Array.isArray(page.items ?? []) ||
        (page.nextPageToken != null && (typeof page.nextPageToken !== 'string' || page.nextPageToken.length > 4096))) {
        throw new CalendarAccessError('unavailable');
    }
    return page;
}

export async function listCalendarEvents(token, day, signal) {
    const url = new URL(CALENDAR_EVENTS_ENDPOINT);
    url.search = new URLSearchParams({
        timeMin: day.start.toISOString(),
        timeMax: day.end.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        fields: 'nextPageToken,items(summary,start(date,dateTime),end(date,dateTime),status)',
        maxResults: '250'
    });

    const events = [];
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
    let pageToken;
    for (let page = 0; page < 5; page++) {
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            signal: deadline
        });
        if (response.status === 401) throw new CalendarAccessError('expired');
        if (response.status === 403) throw new CalendarAccessError('forbidden');
        if (!response.ok) throw new CalendarAccessError('unavailable');

        const result = await readCalendarPage(response);
        for (const item of result.items ?? []) {
            const event = toPreviewEvent(item, day);
            if (event) events.push(event);
        }
        if (pageToken && result.nextPageToken === pageToken) throw new CalendarAccessError('unavailable');
        pageToken = result.nextPageToken;
        if (!pageToken || events.length >= 1000) break;
    }

    return { events: events.slice(0, 1000), partial: !!pageToken || events.length > 1000 };
}
