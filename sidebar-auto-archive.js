import './sidebar-auto-archive.css';
import { Logger } from './logger.js';
import { Utils } from './utils.js';

const selectors = '.clean-archive-controls';
const renderBySlot = new WeakMap();
let refreshVersion = 0;
let pendingWrite = Promise.resolve();

async function refreshControls() {
    const version = ++refreshVersion;
    const settings = await Utils.getSettings();
    if (version !== refreshVersion) return;
    document.querySelectorAll(selectors).forEach(slot => renderBySlot.get(slot)?.(settings));
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ('autoArchiveEnabled' in changes || 'autoArchiveIdleMinutes' in changes)) {
        refreshControls().catch(error => Logger.warn('Could not read auto-archive settings:', error));
    }
});

export function setupCleanArchiveControls(spaceElement) {
    const slot = spaceElement.querySelector(selectors);
    if (!slot) return;
    slot.innerHTML = `
        <label class="clean-archive-row clean-archive-heading">
            <span class="clean-archive-caption">
                <span class="clean-archive-title">Auto-archive</span>
                <span class="clean-archive-scope" aria-hidden="true">All spaces</span>
            </span>
            <input class="clean-archive-toggle" type="checkbox" role="switch" aria-description="Applies to all spaces" disabled>
        </label>
        <label class="clean-archive-row">
            <span>Archive after</span>
            <select class="clean-archive-threshold" aria-description="Inactivity threshold before a tab is archived" disabled>
                <option value="360">6 hours</option>
                <option value="720">12 hours</option>
                <option value="1440" selected>24 hours</option>
                <option value="2880">48 hours</option>
                <option value="10080">7 days</option>
                <option value="custom">Custom…</option>
            </select>
        </label>
        <label class="clean-archive-row clean-archive-custom-label" hidden>
            <span>Minutes</span>
            <input class="clean-archive-custom" type="number" inputmode="numeric" min="1" step="1" required disabled>
        </label>
        <p class="clean-archive-error" role="status" hidden></p>`;

    const toggle = slot.querySelector('.clean-archive-toggle');
    const threshold = slot.querySelector('.clean-archive-threshold');
    const custom = slot.querySelector('.clean-archive-custom');
    const customLabel = custom.closest('label');
    const errorMessage = slot.querySelector('.clean-archive-error');
    const presets = new Set([...threshold.options].map(option => option.value));
    let storedMinutes;

    function render(settings) {
        toggle.checked = settings.autoArchiveEnabled;
        if (storedMinutes !== settings.autoArchiveIdleMinutes) {
            storedMinutes = settings.autoArchiveIdleMinutes;
            const value = String(storedMinutes);
            threshold.value = presets.has(value) ? value : 'custom';
            custom.value = value;
            customLabel.hidden = threshold.value !== 'custom';
        }
        toggle.disabled = false;
        threshold.disabled = custom.disabled = !settings.autoArchiveEnabled;
    }
    renderBySlot.set(slot, render);

    async function save(write) {
        errorMessage.hidden = true;
        const operation = pendingWrite.then(write);
        pendingWrite = operation.catch(() => {});
        try {
            await operation;
        } catch (error) {
            // Force the previously saved interval to replace any unsaved choice.
            storedMinutes = undefined;
            Logger.warn('Could not save auto-archive settings:', error);
            errorMessage.textContent = 'Could not save auto-archive settings.';
            errorMessage.hidden = false;
            await refreshControls().catch(refreshError => Logger.warn('Could not read auto-archive settings:', refreshError));
        }
    }

    toggle.addEventListener('change', () => {
        const enabled = toggle.checked;
        if (!enabled) threshold.disabled = custom.disabled = true;
        save(() => Utils.setArchivingEnabled(enabled));
    });
    threshold.addEventListener('change', () => {
        const isCustom = threshold.value === 'custom';
        customLabel.hidden = !isCustom;
        if (isCustom) {
            custom.value = storedMinutes;
            custom.focus();
            custom.select();
        } else {
            const minutes = Number(threshold.value);
            save(() => Utils.setArchiveTime(minutes));
        }
    });
    custom.addEventListener('change', () => {
        if (!custom.reportValidity()) return;
        const minutes = custom.valueAsNumber;
        save(() => Utils.setArchiveTime(minutes));
    });

    // Space elements are attached after setup. The asynchronous read updates
    // every mounted panel so concurrently added spaces use the same snapshot.
    refreshControls().catch(error => Logger.warn('Could not load auto-archive settings:', error));
}
