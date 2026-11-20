import { INLINE_SWITCHER, setInlineSwitcher } from './tab-switcher-inline-settings.js';
/**
 * Options - Extension settings and preferences UI
 * 
 * Purpose: Provides user interface for configuring extension behavior and preferences
 * Key Functions: Default space configuration and extension preferences management
 * Architecture: Options page that syncs with chrome.storage for persistent settings
 * 
 * Critical Notes:
 * - Settings stay in this Chrome profile via chrome.storage.local
 * - Changes trigger background script updates via message passing
 * - Provides real-time feedback for setting changes
 */

import { getAppearanceTheme, setAppearanceTheme } from './space-client.js';
import { APPEARANCE_THEME_KEY, SPACE_COLOR_NAMES } from './space-colors.js';
import { Utils } from './utils.js';
import { LocalStorage } from './localstorage.js';
import { Logger } from './logger.js';
import { parsePreviewDomains, TAB_SWITCHER_EXCLUDED_DOMAINS, TAB_SWITCHER_CAPTURE_ON_VISIT, TAB_SWITCHER_PAGE_PREVIEWS, TAB_SWITCHER_VISIT_PERMISSION } from './tab-switcher-previews.js';
import { enableVisitPreviews, setPreviewPreferences, TAB_PREVIEW_HINT_DISMISSED } from './tab-switcher-preview-settings.js';

// Helper to safely get checkbox value with default
function getCheckboxValue(element, defaultValue) {
  return element ? element.checked : defaultValue;
}

// Helper to safely set checkbox value with default
function setCheckboxValue(element, value, defaultValue) {
  if (element) {
    element.checked = value !== undefined ? value : defaultValue;
  }
}

// Helper to add event listener if element exists
function addListenerIfExists(elementId, event, handler) {
  const element = document.getElementById(elementId);
  if (element) {
    element.addEventListener(event, handler);
  }
  return element;
}

// Function to save options to chrome.storage
async function saveOptions() {
  const defaultSpaceNameSelect = document.getElementById('defaultSpaceName');

  const settings = {
    defaultSpaceName: defaultSpaceNameSelect?.value || 'Home',
    syncTabGroups: getCheckboxValue(document.getElementById('syncTabGroups'), false),
    invertTabOrder: getCheckboxValue(document.getElementById('invertTabOrder'), true),
    showAllOpenTabsInCollapsedFolders: getCheckboxValue(document.getElementById('showAllOpenTabsInCollapsedFolders'), false),
    debugLoggingEnabled: getCheckboxValue(document.getElementById('debugLoggingEnabled'), false)
  };

  try {
    await chrome.storage.local.set(settings);
    Logger.log('Settings saved:', settings);

    showToast();
  } catch (error) {
    Logger.error('Error saving settings:', error);
    showToast('Could not save settings. Please try again.');
  }
}

// Function to show toast notification
let toastTimeout;
function showToast(message = 'Settings saved') {
  const toast = document.getElementById('saveToast');
  if (!toast) return;

  toast.querySelector('.toast-message').textContent = message;
  clearTimeout(toastTimeout);
  toast.classList.add('show');

  // Remove show class after 2 seconds
  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 2000);
}

// Function to restore options from chrome.storage
async function restoreOptions() {
  const settings = await Utils.getSettings();

  await populateSpacesDropdown(settings.defaultSpaceName);

  // Restore checkbox values
  setCheckboxValue(document.getElementById('syncTabGroups'), settings.syncTabGroups, false);
  setCheckboxValue(document.getElementById('invertTabOrder'), settings.invertTabOrder, true);
  setCheckboxValue(document.getElementById('showAllOpenTabsInCollapsedFolders'), settings.showAllOpenTabsInCollapsedFolders, false);
  setCheckboxValue(document.getElementById('debugLoggingEnabled'), settings.debugLoggingEnabled, false);
}

// Function to populate the spaces dropdown
async function populateSpacesDropdown(selectedSpaceName) {
  const defaultSpaceNameSelect = document.getElementById('defaultSpaceName');

  try {
    // Get space names using the LocalStorage utility function
    const spaceNames = await LocalStorage.getSpaceNames();

    // Clear existing options
    defaultSpaceNameSelect.innerHTML = '';

    // Add space options
    spaceNames.forEach(spaceName => {
      const option = document.createElement('option');
      option.value = spaceName;
      option.textContent = spaceName;
      defaultSpaceNameSelect.appendChild(option);
    });

    // Only add default "Home" option if no spaces were found
    if (spaceNames.length === 0) {
      const defaultOption = document.createElement('option');
      defaultOption.value = 'Home';
      defaultOption.textContent = 'Home';
      defaultSpaceNameSelect.appendChild(defaultOption);
    }

    // Set the selected value
    defaultSpaceNameSelect.value = spaceNames.includes(selectedSpaceName) ? selectedSpaceName : (spaceNames[0] || 'Home');

  } catch (error) {
    Logger.error('Error loading spaces:', error);
    // Fallback to default option if there's an error
    defaultSpaceNameSelect.innerHTML = '<option value="Home">Home</option>';
    defaultSpaceNameSelect.value = 'Home';
  }
}

function setupSectionNavigation() {
  const items = [...document.querySelectorAll('.options-nav a')].map(link => {
    const heading = document.getElementById(link.hash.slice(1));
    return { link, section: heading.closest('.options-section') };
  });
  let currentLink;
  let frame;

  function update() {
    frame = undefined;
    const anchor = document.getElementById(location.hash.slice(1));
    const anchorBounds = anchor?.getBoundingClientRect();
    const viewportHeight = document.documentElement.clientHeight;
    // A direct link can land short of the viewport top near the end of the page.
    const linkedItem = anchorBounds?.bottom > 0 && anchorBounds.top < viewportHeight
      ? items.find(({ section }) => section.contains(anchor))
      : undefined;
    const threshold = Math.min(96, viewportHeight / 5);
    const visibleItem = items.findLast(({ section }) => section.getBoundingClientRect().top <= threshold);
    const { link } = linkedItem ?? visibleItem ?? items[0];
    if (currentLink === link) return;
    for (const item of items) item.link.removeAttribute('aria-current');
    link.setAttribute('aria-current', 'location');
    currentLink = link;
  }

  function updateOnFrame() {
    frame ??= requestAnimationFrame(update);
  }

  for (const event of ['hashchange', 'resize', 'scroll']) window.addEventListener(event, updateOnFrame);
  updateOnFrame();
}

function setupAdvancedOptions() {
  const toggle = document.getElementById('advancedOptionsToggle');
  const content = document.getElementById('advancedOptionsContent');

  if (toggle && content) {
    toggle.addEventListener('click', () => {
      content.hidden = !content.hidden;
      toggle.setAttribute('aria-expanded', String(!content.hidden));
    });
  }
}

async function setupAppearance() {
  const select = document.getElementById('appearanceTheme');

  function showTheme(theme) {
    select.value = theme;
    document.documentElement.dataset.appearance = theme;
  }

  let receivedTheme = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[APPEARANCE_THEME_KEY]?.newValue) {
      receivedTheme = true;
      showTheme(changes[APPEARANCE_THEME_KEY].newValue);
    }
  });
  try {
    const theme = await getAppearanceTheme();
    if (!receivedTheme) showTheme(theme);
    select.disabled = false;
  } catch {
    showToast('Could not load the theme. Reopen Settings to try again.');
    return;
  }

  select.addEventListener('change', async () => {
    const previous = document.documentElement.dataset.appearance;
    select.disabled = true;
    try {
      showTheme(await setAppearanceTheme(select.value));
      showToast();
    } catch {
      showTheme(previous);
      showToast('Could not save the theme. Try again.');
    } finally {
      select.disabled = false;
    }
  });
}

async function setupSpaceColors() {
  const grid = document.getElementById('spaceColors');
  const template = document.getElementById('spaceColorRow');
  const colors = new Map();

  const gradientBase = name => getComputedStyle(document.documentElement).getPropertyValue(`--space-${name}-base`).trim();

  function showColors(overrides = {}) {
    for (const [name, { picker, reset }] of colors) {
      const value = overrides?.[name];
      const solid = /^#[0-9a-f]{6}$/i.test(value) ? value : null;
      picker.value = solid || gradientBase(name);
      picker.style.setProperty('--swatch-base', solid || `var(--space-${name}-base)`);
      picker.style.setProperty('--swatch-gradient', solid ? 'none' : `var(--space-${name}-gradient)`);
      picker.title = solid ? 'Change solid color' : 'Choose a solid color';
      reset.disabled = !solid;
    }
  }

  async function saveColor(name, value) {
    try {
      await navigator.locks.request('prismarc-color-overrides', async () => {
        // Other Settings tabs may have edited a different preset.
        const { colorOverrides } = await chrome.storage.local.get('colorOverrides');
        const updated = { ...colorOverrides };
        if (value) updated[name] = value;
        else delete updated[name];
        await chrome.storage.local.set({ colorOverrides: Object.keys(updated).length ? updated : null });
        showColors(updated);
      });
      showToast();
    } catch {
      showToast('Could not save the space color. Try again.');
    }
  }

  for (const name of SPACE_COLOR_NAMES) {
    const row = template.content.firstElementChild.cloneNode(true);
    const label = row.querySelector('label');
    const picker = row.querySelector('input');
    const reset = row.querySelector('button');
    const title = name[0].toUpperCase() + name.slice(1);
    label.textContent = title;
    picker.id = `color${title}`;
    label.htmlFor = picker.id;
    picker.setAttribute('aria-label', `Choose solid color for ${name} spaces`);
    reset.setAttribute('aria-label', `Restore ${name} gradient`);
    reset.dataset.color = name;
    picker.addEventListener('click', () => {
      if (reset.disabled) picker.value = gradientBase(name);
    });
    picker.addEventListener('change', () => saveColor(name, picker.value));
    reset.addEventListener('click', () => saveColor(name, null));
    colors.set(name, { picker, reset });
    grid.append(row);
  }

  let receivedPalette = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.colorOverrides) {
      receivedPalette = true;
      showColors(changes.colorOverrides.newValue);
    }
  });
  try {
    const { colorOverrides } = await chrome.storage.local.get('colorOverrides');
    if (!receivedPalette) showColors(colorOverrides);
  } catch {
    showColors();
    showToast('Could not load space colors. Reopen Settings to try again.');
  }
}

// Function to setup auto-save listeners
function setupAutoSave() {
  // Auto-save for dropdown
  addListenerIfExists('defaultSpaceName', 'change', saveOptions);

  // Auto-save for checkboxes (most just save immediately)
  const checkboxIds = ['syncTabGroups', 'invertTabOrder', 'showAllOpenTabsInCollapsedFolders', 'debugLoggingEnabled'];
  checkboxIds.forEach(id => addListenerIfExists(id, 'change', saveOptions));
}

async function setupPreviewDomains() {
  const form = document.getElementById('previewDomainsForm');
  const field = document.getElementById(TAB_SWITCHER_EXCLUDED_DOMAINS);
  const save = document.getElementById('savePreviewDomains');
  const status = document.getElementById('previewDomainsStatus');
  function report(message, error = false) {
    status.textContent = message;
    status.toggleAttribute('data-error', error);
  }
  try {
    const settings = await chrome.storage.local.get(TAB_SWITCHER_EXCLUDED_DOMAINS);
    field.value = (settings[TAB_SWITCHER_EXCLUDED_DOMAINS] ?? []).join(', ');
    field.disabled = save.disabled = false;
  } catch {
    report('Could not load excluded sites.', true);
    return;
  }
  field.addEventListener('input', () => {
    field.removeAttribute('aria-invalid');
    report('');
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    const draft = field.value;
    let domains;
    try {
      domains = parsePreviewDomains(draft);
    } catch (error) {
      field.setAttribute('aria-invalid', 'true');
      report(error.message, true);
      field.focus();
      return;
    }
    field.removeAttribute('aria-invalid');
    save.disabled = true;
    report('Saving excluded sites…');
    try {
      await setPreviewPreferences(chrome, { [TAB_SWITCHER_EXCLUDED_DOMAINS]: domains });
      if (field.value === draft) {
        field.value = domains.join(', ');
        report('Excluded sites saved.');
      } else {
        report('Select Save excluded sites to apply your latest edits.');
      }
    } catch {
      report('Could not save excluded sites. Try again.', true);
    } finally {
      save.disabled = false;
    }
  });
}

function markSwitchPending(control, pending, related) {
  control.setAttribute('aria-busy', String(pending));
  for (const input of [control, related].filter(Boolean)) {
    if (pending) input.setAttribute('aria-disabled', 'true');
    else input.removeAttribute('aria-disabled');
  }
}

function setupInlineSwitcher() {
  const toggle = document.getElementById(INLINE_SWITCHER);
  if (!toggle) return;
  let choice;
  let busy = false;
  let revision = 0;

  async function refresh() {
    const request = ++revision;
    const [settings, grants] = await Promise.all([
      chrome.storage.local.get(INLINE_SWITCHER),
      chrome.permissions.getAll(),
    ]);
    if (request !== revision) return;
    choice = settings[INLINE_SWITCHER];
    const hostAccess = grants.origins?.some(origin => origin === '<all_urls>' || /^(?:https?|\*):\/\//.test(origin));
    toggle.checked = choice === true && grants.permissions?.includes('scripting') && hostAccess;
    toggle.disabled = false;
  }

  const update = () => refresh().catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[INLINE_SWITCHER]) update();
  });
  chrome.permissions.onAdded.addListener(update);
  chrome.permissions.onRemoved.addListener(update);
  toggle.addEventListener('click', async event => {
    const checked = toggle.checked;
    // Keep the last effective state visible until the native request and save finish.
    event.preventDefault();
    if (!event.isTrusted || busy) return;
    busy = true;
    markSwitchPending(toggle, true);
    try {
      if (!await setInlineSwitcher(chrome, checked, choice)) showToast('Chrome kept the current popup setting.');
      else showToast();
    } catch {
      showToast('Could not change how PrismArc popups open.');
    } finally {
      await update();
      busy = false;
      markSwitchPending(toggle, false);
    }
  });
  update();
}

function setupPagePreviews() {
  const checkbox = document.getElementById(TAB_SWITCHER_PAGE_PREVIEWS);
  const visitToggle = document.getElementById(TAB_SWITCHER_CAPTURE_ON_VISIT);
  if (!checkbox || !visitToggle) return;
  const keys = [TAB_SWITCHER_PAGE_PREVIEWS, TAB_SWITCHER_CAPTURE_ON_VISIT];
  let busy = false;
  let visitChoice;
  let version = 0;
  const fromPreviewHint = location.hash === `#${TAB_SWITCHER_CAPTURE_ON_VISIT}`;
  let focusPreviewAction = fromPreviewHint;

  async function restore() {
    const request = ++version;
    try {
      const [settings, granted] = await Promise.all([
        chrome.storage.local.get(keys),
        chrome.permissions.contains(TAB_SWITCHER_VISIT_PERMISSION).catch(() => false),
      ]);
      if (request !== version) return;
      checkbox.checked = settings[TAB_SWITCHER_PAGE_PREVIEWS] !== false;
      visitChoice = settings[TAB_SWITCHER_CAPTURE_ON_VISIT];
      visitToggle.checked = checkbox.checked && visitChoice === true && granted;
      checkbox.disabled = false;
      visitToggle.disabled = !checkbox.checked;
      if (focusPreviewAction && !visitToggle.disabled) {
        focusPreviewAction = false;
        if (document.activeElement === document.body) {
          visitToggle.focus({ preventScroll: true });
          visitToggle.closest('.options-setting-item').scrollIntoView({ block: 'nearest' });
        }
      }
    } catch {
      // Leave the controls at their last readable state if Chrome rejects the request.
    }
  }

  function startChange(control, related) {
    busy = true;
    markSwitchPending(control, true, related);
  }

  async function finishChange(control, related) {
    await restore();
    busy = false;
    markSwitchPending(control, false, related);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && keys.some(key => changes[key])) restore();
  });
  chrome.permissions.onAdded.addListener(restore);
  chrome.permissions.onRemoved.addListener(restore);
  restore();

  checkbox.addEventListener('click', async event => {
    const checked = checkbox.checked;
    event.preventDefault();
    if (!event.isTrusted || busy) return;
    startChange(checkbox, visitToggle);
    try {
      const preference = { [TAB_SWITCHER_PAGE_PREVIEWS]: checked };
      if (!checked) preference[TAB_SWITCHER_CAPTURE_ON_VISIT] = false;
      await setPreviewPreferences(chrome, preference);
      showToast();
    } catch {
      showToast('Could not change page previews. Try again.');
    } finally {
      await finishChange(checkbox, visitToggle);
    }
  });

  visitToggle.addEventListener('click', async event => {
    const checked = visitToggle.checked;
    event.preventDefault();
    if (!event.isTrusted || busy || !checkbox.checked) return;
    startChange(visitToggle, checkbox);
    try {
      if (!checked) {
        await setPreviewPreferences(chrome, { [TAB_SWITCHER_CAPTURE_ON_VISIT]: false });
      } else {
        const result = await enableVisitPreviews(chrome, visitChoice);
        if (result === 'denied') {
          if (fromPreviewHint) await chrome.storage.local.set({ [TAB_PREVIEW_HINT_DISMISSED]: true }).catch(() => {});
          showToast('Chrome did not grant access. Shortcut previews are still on.');
          return;
        }
        if (result === 'disabled') return;
      }
      showToast();
    } catch {
      showToast('Could not change previews as you browse.');
    } finally {
      await finishChange(visitToggle, checkbox);
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  restoreOptions();
  setupAppearance();
  setupSpaceColors();
  setupSectionNavigation();
  setupAdvancedOptions();
  setupAutoSave();
  setupInlineSwitcher();
  setupPagePreviews();
  setupPreviewDomains();
});
