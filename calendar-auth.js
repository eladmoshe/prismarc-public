import { BUNDLED_CALENDAR_CLIENT_ID, CALENDAR_CLIENT_KEY, CALENDAR_READ_SCOPE, CALENDAR_REVOKE_ENDPOINT, CALENDAR_SESSION_KEY, isCalendarClientId } from './calendar-config.js';

const CALLBACK_PATH = 'google-calendar';
const PERMISSION = { permissions: ['identity'] };
const STATE_LOCK = 'googleCalendarState';
const GENERATION_KEY = 'googleCalendarGeneration';

export function calendarRedirectUrl(extensionId) {
    return `https://${extensionId}.chromiumapp.org/${CALLBACK_PATH}`;
}

export function createCalendarAuthUrl(clientId, redirectUrl, state) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUrl,
        response_type: 'token',
        scope: CALENDAR_READ_SCOPE,
        state,
        prompt: 'select_account'
    });
    return url.href;
}

export function parseCalendarAuthResponse(responseUrl, expectedUrl, expectedState, now = Date.now()) {
    const response = new URL(responseUrl);
    const actual = new URL(response);
    actual.hash = '';
    if (actual.href !== expectedUrl) throw new Error('Invalid Calendar sign-in redirect.');

    const params = new URLSearchParams(response.hash.slice(1));
    const scopes = params.get('scope')?.split(/\s+/) ?? [];
    const token = params.get('access_token');
    const expiry = params.get('expires_in');
    const expiresIn = Number(expiry);
    if (params.getAll('state').length !== 1 || params.get('state') !== expectedState || params.has('error') ||
        params.getAll('access_token').length !== 1 || !token || !/^[A-Za-z0-9._~+/-]+=*$/.test(token) ||
        token.length > 4096 || params.get('token_type')?.toLowerCase() !== 'bearer' ||
        scopes.length !== 1 || scopes[0] !== CALENDAR_READ_SCOPE || !/^\d{1,6}$/.test(expiry) || expiresIn < 1) {
        throw new Error('Invalid Calendar sign-in response.');
    }

    return { token, expiresAt: now + Math.min(expiresIn, 3600) * 1000 };
}

export async function getCalendarClient() {
    if (BUNDLED_CALENDAR_CLIENT_ID) return BUNDLED_CALENDAR_CLIENT_ID;
    const { [CALENDAR_CLIENT_KEY]: clientId } = await chrome.storage.local.get(CALENDAR_CLIENT_KEY);
    return isCalendarClientId(clientId) ? clientId : null;
}

export async function getCalendarSession(clientId) {
    const { [CALENDAR_SESSION_KEY]: session } = await chrome.storage.session.get(CALENDAR_SESSION_KEY);
    if (session?.clientId !== clientId || !Number.isFinite(session.expiresAt)) return null;
    if (!session.token || await chrome.permissions.contains(PERMISSION)) return session;
    const expired = await handleCalendarPermissionRemoval();
    return expired?.clientId === clientId ? expired : null;
}

export async function connectCalendar(clientId) {
    if (!isCalendarClientId(clientId)) throw new Error('Calendar setup is required.');
    const [attempt, granted] = await Promise.all([
        chrome.storage.session.get(GENERATION_KEY),
        chrome.permissions.request(PERMISSION)
    ]);
    if (!granted) throw new Error('Calendar sign-in permission is required.');
    // Recheck configuration after Google's asynchronous dialog so a settings
    // change or disconnect in another sidebar cannot revive an old attempt.
    return navigator.locks.request(CALENDAR_SESSION_KEY, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Calendar sign-in is already open.');
        const generation = await chrome.storage.session.get(GENERATION_KEY);
        if (generation[GENERATION_KEY] !== attempt[GENERATION_KEY]) throw new Error('Calendar sign-in was disconnected.');
        const redirectUrl = chrome.identity.getRedirectURL(CALLBACK_PATH);
        if (redirectUrl !== calendarRedirectUrl(chrome.runtime.id)) {
            throw new Error('This browser uses an unexpected Calendar sign-in redirect.');
        }
        const state = crypto.randomUUID();
        const responseUrl = await chrome.identity.launchWebAuthFlow({
            url: createCalendarAuthUrl(clientId, redirectUrl, state),
            interactive: true
        });
        const session = parseCalendarAuthResponse(responseUrl, redirectUrl, state);
        await navigator.locks.request(STATE_LOCK, async () => {
            const current = await chrome.storage.session.get(GENERATION_KEY);
            if (current[GENERATION_KEY] !== attempt[GENERATION_KEY] ||
                await getCalendarClient() !== clientId || !await chrome.permissions.contains(PERMISSION)) {
                throw new Error('Calendar sign-in was disconnected.');
            }
            await chrome.storage.session.set({ [CALENDAR_SESSION_KEY]: { id: state, clientId, ...session } });
        });
    });
}

async function clearCalendarSession() {
    await chrome.storage.session.set({ [GENERATION_KEY]: crypto.randomUUID() });
    await chrome.storage.session.remove(CALENDAR_SESSION_KEY);
}

export function expireCalendarSession(id) {
    return navigator.locks.request(STATE_LOCK, async () => {
        const { [CALENDAR_SESSION_KEY]: session } = await chrome.storage.session.get(CALENDAR_SESSION_KEY);
        if (session?.id === id && session?.token) {
            const { clientId } = session;
            await chrome.storage.session.set({ [CALENDAR_SESSION_KEY]: { id, clientId, expiresAt: 0 } });
        }
    });
}

export function handleCalendarPermissionRemoval() {
    return navigator.locks.request(STATE_LOCK, async () => {
        if (await chrome.permissions.contains(PERMISSION)) return null;
        const { [CALENDAR_SESSION_KEY]: session } = await chrome.storage.session.get(CALENDAR_SESSION_KEY);
        const changes = { [GENERATION_KEY]: crypto.randomUUID() };
        const expired = session && { id: session.id, clientId: session.clientId, expiresAt: 0 };
        if (session?.token) changes[CALENDAR_SESSION_KEY] = expired;
        await chrome.storage.session.set(changes);
        return expired;
    });
}

export function disconnectCalendar() {
    return navigator.locks.request(STATE_LOCK, async () => {
        const { [CALENDAR_SESSION_KEY]: session } = await chrome.storage.session.get(CALENDAR_SESSION_KEY);
        await clearCalendarSession();
        try {
            if (!session?.token) return false;
            const response = await fetch(CALENDAR_REVOKE_ENDPOINT, {
                method: 'POST',
                body: new URLSearchParams({ token: session.token }),
                credentials: 'omit',
                redirect: 'error',
                cache: 'no-store',
                referrerPolicy: 'no-referrer',
                signal: AbortSignal.timeout(5000)
            });
            return response.ok;
        } catch {
            return false;
        } finally {
            await chrome.permissions.remove(PERMISSION);
        }
    });
}

export function saveCalendarClient(clientId) {
    return navigator.locks.request(STATE_LOCK, async () => {
        await chrome.permissions.remove(PERMISSION);
        await clearCalendarSession();
        if (clientId) await chrome.storage.local.set({ [CALENDAR_CLIENT_KEY]: clientId });
        else await chrome.storage.local.remove(CALENDAR_CLIENT_KEY);
    });
}
