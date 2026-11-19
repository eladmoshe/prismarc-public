import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarRedirectUrl, createCalendarAuthUrl, parseCalendarAuthResponse } from '../../calendar-auth.js';
import { CALENDAR_EVENTS_ENDPOINT, CALENDAR_READ_SCOPE, calendarCreateUrl, calendarFavoriteUrl } from '../../calendar-config.js';
import { HOUR, getLocalCalendarDay, listCalendarEvents, placeCalendarEvents } from '../../calendar-events.js';

const callback = calendarRedirectUrl('abcdefghijklmnopabcdefghijklmnop');
const state = 'local-fixture-state';
const clientId = '123456789-fixtureclient.apps.googleusercontent.com';
const token = 'synthetic-fixture-data';

function fragment(params = {}) {
    return new URLSearchParams({
        access_token: token, state, scope: CALENDAR_READ_SCOPE, expires_in: '3600', token_type: 'Bearer', ...params
    });
}

test('Calendar preview recognizes HTTPS Google Calendar and preserves the pinned account for Create', () => {
    for (const url of ['https://calendar.google.com.example.org', 'https://calendar.google.com@x.test',
        'https://x@calendar.google.com', 'http://calendar.google.com', 'https://calendar.google.com:444/', 'not a url']) {
        assert.equal(calendarFavoriteUrl(url), null);
    }
    assert.equal(calendarCreateUrl(calendarFavoriteUrl('https://calendar.google.com/calendar/u/2/r/day')),
        'https://calendar.google.com/calendar/u/2/r/eventedit');
    assert.equal(calendarCreateUrl(calendarFavoriteUrl('https://calendar.google.com/')),
        'https://calendar.google.com/calendar/r/eventedit');
});

test('Google auth uses the exact callback, an account chooser and one owned-events read scope', () => {
    const url = new URL(createCalendarAuthUrl(clientId, callback, state));
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.pathname, '/o/oauth2/v2/auth');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
        client_id: clientId, redirect_uri: callback, response_type: 'token',
        scope: CALENDAR_READ_SCOPE, state, prompt: 'select_account'
    });
});

test('OAuth response validates destination, state, format, scope and expiry', () => {
    assert.deepEqual(parseCalendarAuthResponse(`${callback}#${fragment()}`, callback, state, 100), {
        token, expiresAt: 3600100
    });
    assert.equal(parseCalendarAuthResponse(`${callback}#${fragment({ expires_in: '7200' })}`, callback, state, 0).expiresAt, 3600000);
    for (const result of [
        `https://example.test/google-calendar#${fragment()}`,
        `${callback}/other#${fragment()}`, `${callback}?${fragment()}`,
        `${callback}?unexpected=true#${fragment()}`,
        `${callback}#${fragment()}&state=${state}`,
        `${callback}#${fragment()}&access_token=${token}`,
        ...[{ state: 'different' }, { scope: 'other' }, { scope: `${CALENDAR_READ_SCOPE} other` },
            { expires_in: '0' }, { expires_in: '-42' }, { expires_in: 'Infinity' }, { token_type: 'Other' },
            { access_token: 'bad\nheader' }, { error: 'access_denied' }].map(params => `${callback}#${fragment(params)}`)
    ]) assert.throws(() => parseCalendarAuthResponse(result, callback, state), /Invalid Calendar sign-in/);
});

test('Calendar day uses local midnights through DST changes', () => {
    const original = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
        const spring = getLocalCalendarDay(new Date(2026, 2, 8, 12));
        const fall = getLocalCalendarDay(new Date(2026, 10, 1, 12));
        assert.equal(spring.date, '2026-03-08');
        assert.equal((spring.end - spring.start) / HOUR, 23);
        assert.equal((fall.end - fall.start) / HOUR, 25);
    } finally {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
    }
});

test('Calendar blocks clip across midnight and use separate columns for overlaps', () => {
    const day = getLocalCalendarDay(new Date(2026, 10, 18, 12));
    const start = +day.start;
    const events = [
        { title: 'overnight', start: start - HOUR, end: start + HOUR },
        { title: 'overlap', start: start + HOUR / 2, end: start + 2 * HOUR },
        { title: 'later', start: start + 3 * HOUR, end: start + 4 * HOUR }
    ];
    assert.deepEqual(placeCalendarEvents(events, day).map(({ title, column, columns, top, height }) =>
        ({ title, column, columns, top, height })), [
        { title: 'overnight', column: 0, columns: 2, top: 0, height: 1 },
        { title: 'overlap', column: 1, columns: 2, top: .5, height: 1.5 },
        { title: 'later', column: 0, columns: 1, top: 3, height: 1 }
    ]);
});

test('Calendar events query stays on Google, requests only today, and projects safe event fields', async t => {
    const day = getLocalCalendarDay(new Date(2026, 10, 18, 12));
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        requests.push({ url: new URL(url), options });
        if (requests.length === 1) return Response.json({
            nextPageToken: 'next synthetic page',
            items: [
                { summary: 'All day', start: { date: '2026-11-17' }, end: { date: '2026-11-19' } },
                { summary: 'Tomorrow', start: { date: '2026-11-19' }, end: { date: '2026-11-20' } },
                { status: 'cancelled', summary: 'Cancelled', start: { date: day.date }, end: { date: '2026-11-19' } }
            ]
        });
        return Response.json({ items: [{ summary: 'Timed', description: 'private fixture unused',
            htmlLink: 'https://example.com/', start: { dateTime: day.start.toISOString() },
            end: { dateTime: new Date(+day.start + HOUR).toISOString() } }] });
    });
    const result = await listCalendarEvents(token, day, new AbortController().signal);
    assert.deepEqual(result, { events: [{ title: 'All day', allDay: true }, {
        title: 'Timed', start: +day.start, end: +day.start + HOUR
    }], partial: false });
    assert.equal(requests.length, 2);
    for (const { url, options } of requests) {
        assert.equal(url.origin + url.pathname, CALENDAR_EVENTS_ENDPOINT);
        assert.equal(url.searchParams.get('timeMin'), day.start.toISOString());
        assert.equal(url.searchParams.get('timeMax'), day.end.toISOString());
        assert.equal(url.searchParams.get('singleEvents'), 'true');
        assert.equal(url.href.includes(token), false);
        assert.equal(options.headers.Authorization, `Bearer ${token}`);
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.referrerPolicy, 'no-referrer');
    }
    assert.equal(requests[1].url.searchParams.get('pageToken'), 'next synthetic page');
});

test('Calendar query bounds pagination and rejects malformed and oversized responses', async t => {
    const day = getLocalCalendarDay();
    let calls = 0;
    let mode = 'pages';
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        if (mode === 'pages') return Response.json({ nextPageToken: String(calls), items: [] });
        if (mode === 'bad') return new Response('<html>sign in</html>');
        if (mode === 'token') return Response.json({ nextPageToken: {}, items: [] });
        if (mode === 'unauthorized') return new Response(null, { status: 401 });
        return Response.json({ items: [], unused: 'X'.repeat(1024 ** 2) });
    });
    const run = () => listCalendarEvents(token, day, new AbortController().signal);
    assert.deepEqual(await run(), { events: [], partial: true });
    assert.equal(calls, 5);
    for (mode of ['bad', 'token', 'oversized']) {
        await assert.rejects(run, { code: 'unavailable' });
    }
    mode = 'unauthorized';
    await assert.rejects(run, { code: 'expired' });
});
