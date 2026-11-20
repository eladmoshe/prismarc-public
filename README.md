# PrismArc for Chrome

PrismArc is a fork of [Arcify](https://github.com/nisargkolhe/arcify), originally created by Nisarg Kolhe and maintained by the Arcify contributors. It provides a vertical sidebar for organizing tabs into spaces, saving favorites, and moving between tabs.

The getting-started guide shows your two switching shortcuts. To assign one,
open keyboard shortcut settings from the guide and find **PrismArc**. Click the
pencil beside **Open Quick Switcher** or **Cycle through open tabs** and press
your keys. On Mac, try **Option+A** for Recent Tabs, or keep **Option+Tab** if
it already works. Return to the guide to try the shortcuts. Replay it anytime
from **Settings → Getting started**.

In a regular window, closing a tab with **⌘W** leaves its square Favorite at the top of the sidebar. Click the square to reopen its saved address.

**Delete Space** is disabled for the default space, initially **Home**. To delete it, first choose another space under **Settings → Default space**.

Choose **Light** or **Dark** in **Settings → Appearance** for Quick Switcher, Recent Tabs, and the default sidebar gradient. To give a space its own background, choose one of eight gradients in **Space options**. You can customize a preset with a solid color in Settings and restore its gradient there. The change applies to every space using that preset.

This fork began on **2026-11-16** from [Arcify 5.2.0](https://github.com/nisargkolhe/arcify/tree/e565122217c2c106faa6dccdc4f8ced3ec5b423c). Its changes include local extension storage, a smaller runtime permission surface, native tab and history search, a recent-tab picker, and an optional Google Calendar preview.

This repository contains source snapshots for review. Use a link to a specific commit when reporting a finding or recording which version you reviewed.

While dragging tabs in the sidebar, hover over a space chip to preview its lists and folders. Release over the position you want, or press Escape or right-click to cancel.

Use ⌘-click on macOS or Ctrl-click on Windows and Linux to add or remove individual open tabs from a selection. Shift-click selects a range. Right-click a selected tab to move the group or put it in a folder.

Click a space name to collapse or expand its pinned bookmarks, or a folder name to toggle that folder’s contents. Use **Rename Space** in the space menu to edit its name.

## Build and review

Check out the revision you want to review. With Node.js 22.13 or later on the 22.x line or Node.js 24 or later, run:

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm ci
npm run lint
npm run test:unit
npm run build:local
```

The build verifies the extension manifest and produces `dist/` and `arcify-extension.zip`. To try it, open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked**, and choose `dist/`. Use a disposable Chrome profile with synthetic data for evaluation.

Use `npm run build:chrome-web-store` to build the Chrome Web Store package.
It creates `dist-store/` and `prismarc-chrome-web-store.zip`, with Calendar
available only in the local build.

## Permissions and data use

See the [Chrome Web Store release privacy policy](PRIVACY-CHROME-WEB-STORE.md)
and the [local build privacy policy](PRIVACY.md).

- **Tabs and bookmarks.** PrismArc uses Chrome's tab and bookmark APIs to organize spaces, favorites, and saved tabs. Chrome grants access to profile bookmarks. Chrome's own profile sync settings can sync those bookmarks. Extension settings and saved state use local or session storage. Clean offers a 20-second Undo that reopens pages in their original space and order. The extension holds the URLs for that action in worker memory. An audible or muted tab's speaker button toggles its native mute setting.
- **Settings.** Use the section index to jump to tab, switcher, color, and troubleshooting settings. Edit the list of sites excluded from previews under **Recent Tabs & Quick Switcher**, then select **Save excluded sites**.
- **Zoom launch tabs.** PrismArc closes a Zoom meeting launcher about a minute after you open it. Switching the tab to the Zoom web client or another page cancels cleanup. The timer uses only a browser tab ID and deadline.
- **Quick Switcher.** The switcher searches open tabs, bookmarks, and browsing history locally without maintaining a separate search index. The history permission also allows writes. Choosing **Delete from browser history** on a history result removes all visits to the exact URLs represented by that result. There is no undo for history deletion. Selecting **Search Google** sends the typed query to Google through browser navigation.
- **PrismArc popups over webpages.** An optional Settings control places Recent Tabs and Quick Switcher over permitted web pages. Chrome asks for optional scripting and site access. An isolated listener opens an authenticated extension frame when you invoke a switcher. Queries, results, and tab previews stay in the extension. Unavailable pages use the usual popup windows. Deleting a history result from the overlay requires confirmation in the Quick Switcher window. This preference is separate from browsing screenshots.
- **Tab previews.** On macOS, invoking the recent-tab picker can capture the foreground page using the current-tab grant. Up to five landscape previews show tab titles and websites. The popup fits the current display, and smaller viewports use compact rows. If a preview is missing, the picker can offer a dismissible shortcut to the optional browsing-preview setting. **Capture previews while browsing** requests optional all-sites access to capture visible pages during normal browsing. Captures can include embedded page content. PrismArc excludes private windows and keeps up to five thumbnails on this device. Shortcut-only previews expire in memory after ten minutes. Browsing previews are encrypted on disk with a key held in Chrome’s session memory. The picker decrypts its cards when opened. Closing or navigating a tab discards its thumbnail.
- **Google Calendar in the local build.** Calendar preview uses optional Chrome identity permission and requires explicit Google sign-in. Once connected, opening or refreshing the preview fetches today's primary calendar events directly from Google. The OAuth scope permits reading events on calendars owned by the chosen account. PrismArc displays titles and times, keeps event data in memory, and stores the short-lived token in browser-session storage. **Disconnect** clears local access and asks Google to revoke the session token. The **+** action opens Google's event editor in a tab.
- **Other permissions.** Tab groups support optional mirroring of spaces into Chrome groups. The extension uses alarms for optional idle-tab archiving and preview expiry, browser-provided favicons for tab icons, and a write-only clipboard helper to copy the active URL on request. Debug logging is off by default and can include browsing metadata when enabled.

For an organizational pilot, keep Calendar disconnected, **Show PrismArc popups over webpages** off, and **Capture previews while browsing** off until the relevant administrators and security reviewers approve them. Calendar sign-in requires a configured OAuth client and validation against the intended browser and account policies.

The [extension manifest](manifest.json) lists the complete permission set. For the main data paths, see [history search and deletion](quick-switcher-search.js), [tab previews](tab-switcher-previews.js), [Calendar authorization](calendar-auth.js), and [Calendar requests](calendar-events.js).

## License

PrismArc is distributed under the [GNU General Public License v3.0](LICENSE), which allows use, modification, and redistribution under its terms. The [modification notice](NOTICE) records changes from Arcify. If you distribute a modified version, retain copyright and license notices, identify and date your changes, and provide the corresponding source under GPLv3 if you distribute a built package.
