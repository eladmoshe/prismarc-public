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

import { Utils } from './utils.js';
import { LocalStorage } from './localstorage.js';
import { Logger } from './logger.js';
import { parsePreviewDomains, TAB_SWITCHER_EXCLUDED_DOMAINS, TAB_SWITCHER_CAPTURE_ON_VISIT, TAB_SWITCHER_PAGE_PREVIEWS, TAB_SWITCHER_VISIT_PERMISSION } from './tab-switcher-previews.js';
import { enableVisitPreviews, setPreviewPreferences, TAB_PREVIEW_HINT_DISMISSED } from './tab-switcher-preview-settings.js';

// Default color values (must be 6-digit hex for color picker compatibility)
const DEFAULT_COLORS = {
  grey: '#cccccc',
  blue: '#8bb3f3',
  red: '#ff9e97',
  yellow: '#ffe29f',
  green: '#8bda99',
  pink: '#fbaad7',
  purple: '#d6a6ff',
  cyan: '#a5e2ea'
};

const COLOR_NAMES = Object.keys(DEFAULT_COLORS);

// Helper to get color picker element ID from color name
function getColorPickerId(colorName) {
  return `color${colorName.charAt(0).toUpperCase() + colorName.slice(1)}`;
}

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

  // Collect color overrides (only non-default values)
  const colorOverrides = {};
  COLOR_NAMES.forEach(colorName => {
    const colorPicker = document.getElementById(getColorPickerId(colorName));
    if (colorPicker && colorPicker.value !== DEFAULT_COLORS[colorName]) {
      colorOverrides[colorName] = colorPicker.value;
    }
  });

  const settings = {
    defaultSpaceName: defaultSpaceNameSelect?.value || 'Home',
    syncTabGroups: getCheckboxValue(document.getElementById('syncTabGroups'), false),
    invertTabOrder: getCheckboxValue(document.getElementById('invertTabOrder'), true),
    showAllOpenTabsInCollapsedFolders: getCheckboxValue(document.getElementById('showAllOpenTabsInCollapsedFolders'), false),
    colorOverrides: Object.keys(colorOverrides).length > 0 ? colorOverrides : null,
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

  // Restore color overrides
  const colorOverrides = settings.colorOverrides || {};
  COLOR_NAMES.forEach(colorName => {
    const colorPicker = document.getElementById(getColorPickerId(colorName));
    if (colorPicker) {
      colorPicker.value = colorOverrides[colorName] || DEFAULT_COLORS[colorName];
    }
  });
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

  // Setup color reset buttons
  document.querySelectorAll('.color-reset-btn').forEach(button => {
    button.addEventListener('click', () => {
      const colorName = button.dataset.color;
      const colorPicker = document.getElementById(getColorPickerId(colorName));
      if (colorPicker && DEFAULT_COLORS[colorName]) {
        colorPicker.value = DEFAULT_COLORS[colorName];
        saveOptions();
      }
    });
  });
}

// Debounce function to avoid excessive saves for color pickers
let saveTimeout;
function debouncedSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveOptions();
  }, 500); // Wait 500ms after last change before saving
}

// Function to setup auto-save listeners
function setupAutoSave() {
  // Auto-save for dropdown
  addListenerIfExists('defaultSpaceName', 'change', saveOptions);

  // Auto-save for checkboxes (most just save immediately)
  const checkboxIds = ['syncTabGroups', 'invertTabOrder', 'showAllOpenTabsInCollapsedFolders', 'debugLoggingEnabled'];
  checkboxIds.forEach(id => addListenerIfExists(id, 'change', saveOptions));

  // Auto-save for color pickers (with debounce)
  COLOR_NAMES.forEach(colorName => {
    addListenerIfExists(getColorPickerId(colorName), 'input', debouncedSave);
  });
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
  setupSectionNavigation();
  setupAdvancedOptions();
  setupAutoSave();
  setupInlineSwitcher();
  setupPagePreviews();
  setupPreviewDomains();
});
