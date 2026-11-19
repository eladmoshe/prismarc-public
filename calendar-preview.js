import { BUNDLED_CALENDAR_CLIENT_ID, calendarCreateUrl, CALENDAR_CLIENT_KEY, CALENDAR_SESSION_KEY } from './calendar-config.js';
import { connectCalendar, expireCalendarSession, getCalendarClient, getCalendarSession, handleCalendarPermissionRemoval } from './calendar-auth.js';
import { getLocalCalendarDay, HOUR, listCalendarEvents, placeCalendarEvents } from './calendar-events.js';

const PREVIEW_SELECTOR = '.pinned-favicon[data-calendar-favorite]';
const HOVER_DELAY = 380;
const LEAVE_DELAY = 200;
const CACHE_DURATION = 60_000;

export class CalendarPreview {
    constructor(favorites, openTab) {
        this.favorites = favorites;
        this.openTab = openTab;
        this.card = document.createElement('section');
        this.card.id = 'calendarPreview';
        this.card.className = 'calendar-preview';
        this.card.setAttribute('role', 'dialog');
        this.card.setAttribute('aria-label', 'Google Calendar preview');
        this.card.tabIndex = -1;
        this.card.hidden = true;
        this.card.innerHTML = `
            <header class="calendar-preview-header">
                <div><h2>Google Calendar</h2><time class="calendar-preview-date" hidden></time></div>
                <div class="calendar-preview-header-actions">
                    <button type="button" class="calendar-preview-create" title="Create event in the pinned Google Calendar"
                        aria-label="Create event in the pinned Google Calendar" hidden>+</button>
                    <button type="button" class="calendar-preview-settings" title="Calendar settings" aria-label="Calendar settings" hidden>
                        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65"
                            stroke-linecap="round" stroke-linejoin="round">
                            <path d="M10.1 3h3.8l.5 2.2 1.6.9 2.2-.7 1.9 3.3-1.7 1.6v1.9l1.7 1.5-1.9 3.3-2.2-.6-1.6.9-.5 2.2h-3.8l-.5-2.2-1.6-.9-2.2.6-1.9-3.3 1.7-1.5v-1.9L3.9 8.7l1.9-3.3 2.2.7 1.6-.9z" transform="translate(0 1)"/>
                            <circle cx="12" cy="12.3" r="2.8"/>
                        </svg>
                    </button>
                </div>
            </header>
            <div class="calendar-preview-status" role="status">
                <h3 hidden></h3>
                <p></p>
            </div>
            <ul class="calendar-preview-all-day" aria-label="All-day events" hidden></ul>
            <div class="calendar-preview-schedule" tabindex="0" role="region" aria-label="Today's schedule, local time" hidden>
                <div class="calendar-preview-hours">
                    <div class="calendar-preview-events" role="list" aria-label="Timed events"></div>
                </div>
            </div>
            <footer class="calendar-preview-footer" hidden>
                <button type="button" class="calendar-preview-sign-in" hidden>Sign in with Google</button>
                <button type="button" class="calendar-preview-refresh" hidden>Refresh</button>
            </footer>`;
        favorites.after(this.card);

        const find = selector => this.card.querySelector(selector);
        this.headerTitle = find('h2');
        this.date = find('.calendar-preview-date');
        this.statusTitle = find('.calendar-preview-status h3');
        this.status = find('.calendar-preview-status p');
        this.schedule = find('.calendar-preview-schedule');
        this.hours = find('.calendar-preview-hours');
        this.events = find('.calendar-preview-events');
        this.allDay = find('.calendar-preview-all-day');
        this.footer = find('.calendar-preview-footer');
        this.signIn = find('.calendar-preview-sign-in');
        this.refresh = find('.calendar-preview-refresh');
        this.settings = find('.calendar-preview-settings');
        this.create = find('.calendar-preview-create');
        this.nowMarker = document.createElement('div');
        this.nowMarker.className = 'calendar-preview-now';
        this.nowMarker.setAttribute('aria-hidden', 'true');

        this.create.addEventListener('click', () => {
            this.openTab(calendarCreateUrl(new URL(this.anchor.dataset.calendarFavorite))).catch(() => {});
            this.close();
        });
        this.settings.addEventListener('click', () => this.openSettings());
        this.signIn.addEventListener('click', () => this.connect());
        this.refresh.addEventListener('click', () => this.load(true));

        favorites.addEventListener('pointerover', event => this.hover(event));
        favorites.addEventListener('pointerout', event => {
            const anchor = event.target.closest(PREVIEW_SELECTOR);
            if (anchor && !anchor.contains(event.relatedTarget)) this.leave();
        });
        favorites.addEventListener('scroll', () => this.position());
        favorites.addEventListener('click', event => {
            if (event.target.closest(PREVIEW_SELECTOR)) this.close();
        }, true);
        this.card.addEventListener('pointerenter', () => clearTimeout(this.leaveTimer));
        this.card.addEventListener('pointerleave', event => {
            if (!this.anchor?.contains(event.relatedTarget)) this.leave();
        });
        this.card.addEventListener('focusout', () => this.leave());
        this.card.addEventListener('click', event => event.stopPropagation());
        document.addEventListener('pointerdown', event => {
            clearTimeout(this.hoverTimer);
            if (!this.card.contains(event.target)) this.close();
        }, true);
        document.addEventListener('keydown', event => this.keydown(event), true);
        for (const type of ['dragstart', 'arcify:dragstart']) {
            document.addEventListener(type, () => this.close(), true);
        }
        document.addEventListener('contextmenu', event => {
            if (!this.card.contains(event.target)) this.close();
        }, true);
        window.addEventListener('resize', () => this.position());
        document.addEventListener('visibilitychange', () => {
            // The browser-owned consent popup can hide the side panel temporarily.
            if (document.hidden && !this.connecting) this.close();
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if ((area === 'local' && changes[CALENDAR_CLIENT_KEY]) ||
                (area === 'session' && changes[CALENDAR_SESSION_KEY])) {
                this.clearCache();
                this.loadAbort?.abort();
                this.renderEvents();
                if (this.anchor && !this.connecting) {
                    this.setLoadState('checking');
                    this.load();
                }
            }
        });
        chrome.permissions.onRemoved.addListener(({ permissions }) => {
            if (permissions?.includes('identity')) handleCalendarPermissionRemoval().catch(() => {});
        });
    }

    hover(event) {
        const anchor = event.target.closest(PREVIEW_SELECTOR);
        if (!anchor || event.pointerType !== 'mouse' || event.buttons || anchor.contains(event.relatedTarget)) return;
        clearTimeout(this.leaveTimer);
        if (this.anchor === anchor) return;
        if (this.anchor && this.card.contains(document.activeElement)) return;
        this.close();
        this.hoverTimer = setTimeout(() => {
            if (anchor.matches(':hover') && !document.querySelector('.dragging')) this.open(anchor);
        }, HOVER_DELAY);
    }

    leave() {
        clearTimeout(this.hoverTimer);
        clearTimeout(this.leaveTimer);
        this.leaveTimer = setTimeout(() => {
            if (!this.anchor?.matches(':hover') && !this.card.matches(':hover') &&
                !this.card.contains(document.activeElement)) this.close();
        }, LEAVE_DELAY);
    }

    keydown(event) {
        const anchor = event.target.closest(PREVIEW_SELECTOR);
        if (event.key === 'ArrowDown' && anchor) {
            event.preventDefault();
            event.stopPropagation();
            if (this.anchor !== anchor) this.open(anchor);
            this.card.focus();
        } else if (event.key === 'Escape' && this.anchor) {
            event.preventDefault();
            event.stopPropagation();
            const hasFocus = this.card.contains(document.activeElement);
            const returnTarget = this.anchor;
            this.close();
            if (hasFocus) returnTarget.focus();
        }
    }

    open(anchor) {
        if (!anchor.isConnected || !anchor.matches(PREVIEW_SELECTOR)) return;
        this.close();
        this.anchor = anchor;
        anchor.setAttribute('aria-expanded', 'true');
        this.card.hidden = false;
        this.position();
        if (!this.anchor) return;
        this.renderDay();
        this.setLoadState(this.connecting ? 'connecting' : 'checking');
        this.load();
        this.clock = setInterval(() => {
            const today = getLocalCalendarDay();
            if (this.day.key !== today.key) {
                this.clearCache();
                this.renderDay();
                if (this.expiresAt) {
                    this.loadAbort?.abort();
                    this.setLoadState('stale');
                }
            } else {
                this.updateNow();
                if (this.expiresAt && this.expiresAt <= Date.now()) {
                    this.expiresAt = null;
                    this.clearCache();
                    this.renderEvents();
                    this.setLoadState('expired');
                    expireCalendarSession(this.sessionId).catch(() => {});
                }
            }
        }, 15_000);
    }

    close() {
        clearTimeout(this.hoverTimer);
        clearTimeout(this.leaveTimer);
        clearInterval(this.clock);
        this.loadAbort?.abort();
        this.anchor?.setAttribute('aria-expanded', 'false');
        this.anchor = null;
        this.expiresAt = null;
        this.card.hidden = true;
        this.events.replaceChildren();
        this.allDay.replaceChildren();
    }

    clearCache() {
        clearTimeout(this.cacheTimer);
        this.cache = null;
    }

    position() {
        if (!this.anchor) return;
        if (!this.anchor.matches(PREVIEW_SELECTOR) || !this.anchor.isConnected) {
            this.close();
            return;
        }
        const anchor = this.anchor.getBoundingClientRect();
        const area = this.favorites.getBoundingClientRect();
        if (anchor.bottom <= area.top || anchor.top >= area.bottom) {
            this.close();
            return;
        }
        const width = this.card.offsetWidth;
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchor.left + (anchor.width - width) / 2));
        const below = window.innerHeight - anchor.bottom - 13;
        const above = anchor.top - 13;
        const placeBelow = below >= 300 || below >= above;
        this.card.style.left = `${left}px`;
        this.card.style.top = placeBelow ? `${anchor.bottom + 5}px` : 'auto';
        this.card.style.bottom = placeBelow ? 'auto' : `${window.innerHeight - anchor.top + 5}px`;
        this.card.style.maxHeight = `${Math.max(0, placeBelow ? below : above)}px`;
    }

    renderDay() {
        this.day = getLocalCalendarDay();
        this.date.dateTime = this.day.date;
        this.date.textContent = this.day.start.toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric' });
        const rows = [];
        for (let time = +this.day.start; time < +this.day.end; time += HOUR) {
            const hour = document.createElement('time');
            hour.className = 'calendar-preview-hour';
            hour.dateTime = new Date(time).toISOString();
            hour.textContent = new Date(time).toLocaleTimeString(undefined, { hour: 'numeric' });
            rows.push(hour);
        }
        this.hours.replaceChildren(...rows, this.events);
        this.renderEvents();
        this.updateNow();
        this.schedulePositioned = false;
    }

    updateNow() {
        const now = Date.now();
        this.nowMarker.title = `Now · ${new Date(now).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
        this.nowMarker.style.top = `calc(var(--calendar-hour) * ${(now - this.day.start) / HOUR})`;
    }

    renderEvents(events = []) {
        const allDay = [];
        for (const event of events.filter(item => item.allDay)) {
            const item = document.createElement('li');
            item.textContent = event.title;
            allDay.push(item);
        }
        this.allDay.replaceChildren(...allDay);

        const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
        const timed = placeCalendarEvents(events, this.day).map(event => {
            const block = document.createElement('div');
            block.className = 'calendar-preview-event';
            block.setAttribute('role', 'listitem');
            block.textContent = event.title;
            block.title = `${event.title} · ${time.format(event.start)}–${time.format(event.end)}`;
            block.style.top = `calc(var(--calendar-hour) * ${event.top})`;
            block.style.height = `calc(var(--calendar-hour) * ${event.height})`;
            block.style.left = `${100 * event.column / event.columns}%`;
            block.style.width = `calc(${100 / event.columns}% - 4px)`;
            block.setAttribute('aria-label', block.title);
            return block;
        });
        this.events.replaceChildren(...timed, this.nowMarker);
    }

    setLoadState(state, message = '') {
        const active = document.activeElement;
        const [title, description] = ({
            checking: ['', 'Checking Google Calendar…'],
            setup: ['Calendar setup needed', 'Open Calendar settings to get started.'],
            disconnected: ['Connect your calendar', 'See today’s events here.'],
            connecting: ['', 'Waiting for Google sign-in…'],
            'sign-in-error': ['Sign-in did not complete', 'Try again to connect your calendar.'],
            loading: ['', 'Loading today’s events…'],
            expired: ['Reconnect your calendar', 'Calendar access expired. Sign in again to see your events.'],
            empty: ['No events today', ''],
            partial: ['Some events may be unavailable', 'Refresh to try loading your calendar again.'],
            stale: ['', 'It’s a new day. Refresh to see events.'],
            error: ['Calendar is unavailable', 'Refresh to try again.']
        })[state] || [];
        const hasResults = ['connected', 'empty', 'partial'].includes(state);
        const showTimeline = state === 'connected';

        this.card.classList.toggle('calendar-preview-timeline', showTimeline);
        this.headerTitle.textContent = hasResults ? 'Today' : 'Google Calendar';
        this.date.hidden = !hasResults;
        this.statusTitle.textContent = title || '';
        this.statusTitle.hidden = !title;
        this.status.textContent = message || description || '';
        this.create.hidden = !hasResults;
        this.canChangeSetup = !BUNDLED_CALENDAR_CLIENT_ID && ['disconnected', 'sign-in-error'].includes(state);
        this.settings.hidden = !hasResults && !this.canChangeSetup && !['setup', 'expired', 'error', 'stale'].includes(state);
        this.schedule.hidden = !showTimeline;
        this.allDay.hidden = !showTimeline || !this.allDay.childElementCount;
        this.signIn.hidden = !['disconnected', 'sign-in-error', 'expired'].includes(state);
        this.signIn.textContent = state === 'expired' ? 'Reconnect' : 'Sign in with Google';
        this.refresh.hidden = !['connected', 'empty', 'partial', 'stale', 'error'].includes(state);
        this.footer.hidden = this.signIn.hidden && this.refresh.hidden;
        if (active !== this.card && this.card.contains(active) && active.closest('[hidden]')) this.card.focus();
    }

    async load(force = false) {
        if (!this.anchor || this.connecting) return;
        this.loadAbort?.abort();
        const abort = this.loadAbort = new AbortController();
        let session;
        this.expiresAt = null;
        try {
            const client = await getCalendarClient();
            if (abort.signal.aborted) return;
            this.clientId = client;
            if (!client) {
                this.setLoadState('setup');
                return;
            }
            session = await getCalendarSession(client);
            if (abort.signal.aborted) return;
            if (!session?.token || session.expiresAt <= Date.now()) {
                this.setLoadState(session ? 'expired' : 'disconnected');
                if (session?.token) await expireCalendarSession(session.id);
                return;
            }
            const day = this.day;
            this.expiresAt = session.expiresAt;
            this.sessionId = session.id;
            if (!force && this.cache?.day === day.key && this.cache.sessionId === session.id && Date.now() - this.cache.fetchedAt < CACHE_DURATION) {
                this.showResults(this.cache);
                return;
            }
            this.setLoadState('loading');
            const result = await listCalendarEvents(session.token, day, abort.signal);
            const currentSession = await getCalendarSession(client);
            if (abort.signal.aborted || day !== this.day || !currentSession?.token || session.id !== currentSession.id || currentSession.expiresAt <= Date.now()) return;
            this.clearCache();
            this.cache = { ...result, day: day.key, sessionId: session.id, fetchedAt: Date.now() };
            this.cacheTimer = setTimeout(() => this.clearCache(), CACHE_DURATION);
            this.showResults(this.cache);
        } catch (error) {
            if (abort.signal.aborted) return;
            this.clearCache();
            this.renderEvents();
            if (error.code === 'expired') {
                await expireCalendarSession(session.id).catch(() => {});
                if (!abort.signal.aborted) this.setLoadState('expired');
            } else {
                this.setLoadState('error', error.code === 'forbidden'
                    ? 'Google denied access. Check your account and try again.'
                    : '');
            }
        }
    }

    showResults({ events, partial }) {
        this.renderEvents(events);
        if (!events.length) {
            this.setLoadState(partial ? 'partial' : 'empty');
            return;
        }

        this.setLoadState('connected', partial ? 'More events may be available.' : 'Primary Google Calendar');
        if (!this.schedulePositioned) {
            const hour = Math.floor((Date.now() - this.day.start) / HOUR);
            this.schedule.scrollTop = Math.max(0, (hour - 1) * this.hours.firstElementChild.offsetHeight);
            this.schedulePositioned = true;
        }
    }

    async connect() {
        if (this.connecting || !this.clientId) return;
        const clientId = this.clientId;
        this.connecting = true;
        this.setLoadState('connecting');
        try {
            await connectCalendar(clientId);
        } catch {
            if (await getCalendarClient().catch(() => null) === clientId && this.anchor) {
                this.setLoadState('sign-in-error');
                return;
            }
        } finally {
            this.connecting = false;
        }
        this.load();
    }

    async openSettings() {
        if (this.settings.disabled) return;
        const anchor = this.anchor;
        const url = new URL(chrome.runtime.getURL('calendar-settings.html'));
        if (this.canChangeSetup) url.searchParams.set('repair', '1');
        this.settings.disabled = true;
        try {
            await this.openTab(url.href, true);
            if (this.anchor === anchor) this.close();
        } catch {
            if (this.anchor === anchor) this.status.textContent = 'Could not open Calendar settings. Try again.';
        } finally {
            this.settings.disabled = false;
        }
    }
}
