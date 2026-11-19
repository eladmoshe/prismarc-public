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

// Function to apply color overrides to CSS variables
function applyColorOverrides(colorOverrides) {
  const root = document.documentElement;
  COLOR_NAMES.forEach(colorName => {
    const colorValue = colorOverrides?.[colorName];
    if (colorValue) {
      root.style.setProperty(`--user-chrome-${colorName}-color`, colorValue);
    } else {
      root.style.removeProperty(`--user-chrome-${colorName}-color`);
    }
  });
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

    applyColorOverrides(settings.colorOverrides);
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

  applyColorOverrides(colorOverrides);
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

// Function to setup advanced options toggle
function setupAdvancedOptions() {
  const toggle = document.getElementById('advancedOptionsToggle');
  const content = document.getElementById('advancedOptionsContent');

  if (toggle && content) {
    toggle.addEventListener('click', () => {
      const isExpanded = content.style.display !== 'none';
      content.style.display = isExpanded ? 'none' : 'block';
      toggle.classList.toggle('expanded', !isExpanded);
      toggle.setAttribute('aria-expanded', String(!isExpanded));
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
  const field = document.getElementById(TAB_SWITCHER_EXCLUDED_DOMAINS);
  const save = document.getElementById('savePreviewDomains');
  try {
    const settings = await chrome.storage.local.get(TAB_SWITCHER_EXCLUDED_DOMAINS);
    field.value = (settings[TAB_SWITCHER_EXCLUDED_DOMAINS] ?? []).join(', ');
    field.disabled = save.disabled = false;
  } catch {
    showToast('Could not load excluded sites.');
    return;
  }
  save.addEventListener('click', async () => {
    let domains;
    try {
      domains = parsePreviewDomains(field.value);
    } catch (error) {
      showToast(error.message);
      field.focus();
      return;
    }
    save.disabled = true;
    try {
      await setPreviewPreferences(chrome, { [TAB_SWITCHER_EXCLUDED_DOMAINS]: domains });
      field.value = domains.join(', ');
      showToast();
    } catch {
      showToast('Could not save excluded sites.');
    } finally {
      save.disabled = false;
    }
  });
}

function setupInlineSwitcher() {
  const button = document.getElementById(INLINE_SWITCHER);
  if (!button) return;
  let choice;
  let enabled = false;
  let busy = false;
  let revision = 0;

  async function refresh() {
    const request = ++revision;
    const [settings, grants, platform] = await Promise.all([
      chrome.storage.local.get(INLINE_SWITCHER),
      chrome.permissions.getAll(),
      chrome.runtime.getPlatformInfo(),
    ]);
    if (request !== revision) return;
    if (platform.os !== 'mac') return;
    button.closest('.options-setting-item').style.removeProperty('display');
    choice = settings[INLINE_SWITCHER];
    const hostAccess = grants.origins?.some(origin => origin === '<all_urls>' || /^(?:https?|\*):\/\//.test(origin));
    enabled = choice === true && grants.permissions?.includes('scripting') && hostAccess;
    button.textContent = enabled ? 'Use the Recent Tabs window' : 'Show Recent Tabs over webpages';
    button.disabled = busy;
  }

  const update = () => refresh().catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[INLINE_SWITCHER]) update();
  });
  chrome.permissions.onAdded.addListener(update);
  chrome.permissions.onRemoved.addListener(update);
  button.addEventListener('click', async event => {
    if (!event.isTrusted || busy) return;
    busy = button.disabled = true;
    try {
      if (!await setInlineSwitcher(chrome, !enabled, choice)) showToast('Chrome kept the Recent Tabs window.');
      else showToast();
    } catch {
      showToast('Could not change how Recent Tabs opens.');
    } finally {
      busy = false;
      update();
    }
  });
  update();
}

function setupPagePreviews() {
  const checkbox = document.getElementById(TAB_SWITCHER_PAGE_PREVIEWS);
  const visitButton = document.getElementById(TAB_SWITCHER_CAPTURE_ON_VISIT);
  if (!checkbox || !visitButton) return;
  const keys = [TAB_SWITCHER_PAGE_PREVIEWS, TAB_SWITCHER_CAPTURE_ON_VISIT];
  let busy = false;
  let visitEnabled = false;
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
      visitEnabled = visitChoice === true && granted;
      visitButton.textContent = visitEnabled ? 'Turn off previews as I browse' : 'Enable previews as I browse';
      checkbox.disabled = busy;
      visitButton.disabled = busy || !checkbox.checked;
      if (focusPreviewAction && !visitButton.disabled) {
        focusPreviewAction = false;
        if (document.activeElement === document.body) visitButton.focus();
      }
    } catch {
      // Leave the controls at their last readable state if Chrome rejects the request.
    }
  }

  function startChange() {
    busy = true;
    checkbox.disabled = visitButton.disabled = true;
  }

  async function finishChange() {
    busy = false;
    await restore();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && keys.some(key => changes[key])) restore();
  });
  chrome.permissions.onAdded.addListener(restore);
  chrome.permissions.onRemoved.addListener(restore);
  restore();

  checkbox.addEventListener('change', async () => {
    startChange();
    const checked = checkbox.checked;
    try {
      const preference = { [TAB_SWITCHER_PAGE_PREVIEWS]: checked };
      if (!checked) preference[TAB_SWITCHER_CAPTURE_ON_VISIT] = false;
      await setPreviewPreferences(chrome, preference);
      showToast();
    } catch {
      showToast('Could not change page previews. Try again.');
    } finally {
      await finishChange();
    }
  });

  visitButton.addEventListener('click', async event => {
    if (!event.isTrusted || busy || !checkbox.checked) return;
    startChange();
    try {
      if (visitEnabled) {
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
      await finishChange();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  restoreOptions();
  setupAdvancedOptions();
  setupAutoSave();
  setupInlineSwitcher();
  setupPagePreviews();
  setupPreviewDomains();
});
