export const CALENDAR_ORIGIN = 'https://calendar.google.com';
export const CALENDAR_EVENTS_ENDPOINT = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
export const CALENDAR_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned.readonly';
export const CALENDAR_CLIENT_KEY = 'googleCalendarClientId';
export const CALENDAR_SESSION_KEY = 'googleCalendarSession';
export const BUNDLED_CALENDAR_CLIENT_ID = typeof __PRISMARC_CALENDAR_CLIENT_ID__ === 'string'
    ? __PRISMARC_CALENDAR_CLIENT_ID__
    : '';

export function calendarFavoriteUrl(value) {
    try {
        const url = new URL(value);
        if (url.origin === CALENDAR_ORIGIN && !url.username && !url.password) return url;
    } catch {
        // A Favorite can be tracked before its URL is available.
    }
    return null;
}

export function calendarCreateUrl(favoriteUrl) {
    const account = favoriteUrl.pathname.match(/^\/calendar\/u\/(\d+)(?:\/|$)/)?.[1];
    return new URL(account ? `/calendar/u/${account}/r/eventedit` : '/calendar/r/eventedit', CALENDAR_ORIGIN).href;
}

export function isCalendarClientId(value) {
    return typeof value === 'string' && /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(value);
}
