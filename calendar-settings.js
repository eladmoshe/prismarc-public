import { calendarRedirectUrl, disconnectCalendar, getCalendarClient, getCalendarSession, saveCalendarClient } from './calendar-auth.js';
import { BUNDLED_CALENDAR_CLIENT_ID, CALENDAR_CLIENT_KEY, CALENDAR_SESSION_KEY, isCalendarClientId } from './calendar-config.js';

const GOOGLE_CLIENTS_URL = 'https://console.cloud.google.com/auth/clients';
const repair = !BUNDLED_CALENDAR_CLIENT_ID && new URLSearchParams(location.search).get('repair') === '1';
const states = {
    copy: {
        title: 'Copy the redirect address',
        description: 'You’ll add this address to a Web application in your Google Cloud project.',
        action: 'Copy redirect address'
    },
    manual: {
        title: 'Copy the redirect address',
        description: 'Copy the selected address manually, then continue to Google Cloud.',
        action: 'Continue'
    },
    cloud: {
        title: 'Set up Google Cloud',
        description: 'Enable the Calendar API and add the Calendar Events Owned read-only scope. In Clients, create a Web application and add the copied address under Authorized redirect URIs. Then return here.',
        action: 'Open Google Cloud'
    },
    paste: {
        title: 'Save the setup',
        description: 'Paste the public client ID from your Google Cloud Web application.',
        action: 'Save setup'
    },
    ready: {
        title: 'Ready to sign in',
        description: 'Open the Google Calendar favorite in your sidebar to sign in.',
        action: 'Done'
    },
    connected: {
        title: 'Google Calendar connected',
        description: 'Disconnect to remove local Calendar access and ask Google to revoke this app’s grant. Other installations using the same Google project may need to sign in again.',
        action: 'Disconnect'
    },
    expired: {
        title: 'Calendar access expired',
        description: 'Disconnect to clear this browser’s Calendar connection.',
        action: 'Disconnect'
    },
    error: {
        title: 'Calendar settings are unavailable',
        description: 'Try loading settings again.',
        action: 'Retry'
    }
};

const byId = id => document.getElementById(id);
const heading = byId('calendarSettingsHeading');
const description = byId('calendarSettingsDescription');
const form = byId('calendarSettingsForm');
const field = byId('calendarSettingsField');
const input = byId('calendarSettingsClient');
const manual = byId('calendarSettingsManual');
const address = byId('calendarSettingsAddress');
const action = byId('calendarSettingsAction');
const back = byId('calendarSettingsBack');
const change = byId('calendarSettingsChange');
const status = byId('calendarSettingsStatus');

let state;
let busy = false;
let updating = 0;

function show(nextState, focus = false) {
    state = nextState;
    const view = states[state];
    heading.textContent = view.title;
    description.textContent = view.description;
    action.textContent = view.action;
    status.textContent = '';
    form.hidden = false;
    field.hidden = state !== 'paste';
    if (field.hidden) input.value = '';
    manual.hidden = state !== 'manual';
    address.value = manual.hidden ? '' : calendarRedirectUrl(chrome.runtime.id);
    back.hidden = !['manual', 'cloud', 'paste'].includes(state) && !(state === 'copy' && repair);
    change.hidden = !(state === 'ready' && repair);
    if (focus) heading.focus();
}

async function load(focus = false) {
    const request = ++updating;
    try {
        const client = await getCalendarClient();
        const session = client ? await getCalendarSession(client) : null;
        if (request !== updating) return;
        if (session) show(session.token && session.expiresAt > Date.now() ? 'connected' : 'expired', focus);
        else show(client ? 'ready' : 'copy', focus);
    } catch {
        if (request === updating) show('error', focus);
    }
}

back.addEventListener('click', () => {
    if (state === 'copy') load(true);
    else show(state === 'paste' ? 'cloud' : 'copy', true);
});
change.addEventListener('click', () => show('copy', true));

async function disconnect() {
    const revoked = await disconnectCalendar();
    show('ready', true);
    if (!revoked) status.textContent = 'Disconnected locally. To confirm removal of Google access, open your Google Account and review third-party connections.';
}

const actions = {
    async copy() {
        const redirect = calendarRedirectUrl(chrome.runtime.id);
        try {
            await navigator.clipboard.writeText(redirect);
        } catch {
            const buffer = document.createElement('textarea');
            buffer.className = 'calendar-settings-copy-buffer';
            buffer.readOnly = true;
            buffer.value = redirect;
            document.body.append(buffer);
            let copied = false;
            try {
                buffer.select();
                copied = document.execCommand('copy');
            } catch {
                // Managed browser policies can block the older clipboard API too.
            } finally {
                buffer.remove();
            }
            if (!copied) {
                show('manual');
                address.focus();
                address.select();
                return;
            }
        }
        show('cloud', true);
    },
    manual: () => show('cloud', true),
    async cloud() {
        await chrome.tabs.create({ url: GOOGLE_CLIENTS_URL });
        show('paste', true);
    },
    async paste() {
        const client = input.value.trim();
        if (!isCalendarClientId(client)) {
            status.textContent = 'Paste the public client ID from your Google Cloud Web application.';
            input.focus();
            return;
        }
        await saveCalendarClient(client);
        show('ready', true);
    },
    connected: disconnect,
    expired: disconnect,
    async ready() {
        const tab = await chrome.tabs.getCurrent();
        if (tab) await chrome.tabs.remove(tab.id);
    },
    error: () => load(true)
};

form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    action.disabled = back.disabled = change.disabled = true;
    try {
        await actions[state]();
    } catch {
        status.textContent = 'That action did not complete. Try again.';
    } finally {
        busy = false;
        action.disabled = back.disabled = change.disabled = false;
    }
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (!busy && ['ready', 'connected', 'expired'].includes(state) &&
        ((area === 'local' && changes[CALENDAR_CLIENT_KEY]) || (area === 'session' && changes[CALENDAR_SESSION_KEY]))) {
        load();
    }
});

load();
