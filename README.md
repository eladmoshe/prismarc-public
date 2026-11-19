# Prismark · PrismArc for Chrome

Prismark is a fork of [Arcify](https://github.com/nisargkolhe/arcify), originally created by Nisarg Kolhe and maintained by the Arcify contributors. The extension appears as **PrismArc** in Chrome. It provides a vertical sidebar for organizing tabs into spaces, saving favorites, and moving between tabs.

This fork began on **2026-11-16** from [Arcify 5.2.0](https://github.com/nisargkolhe/arcify/tree/e565122217c2c106faa6dccdc4f8ced3ec5b423c). Its changes include local extension storage, a smaller runtime permission surface, native tab and history search, a recent-tab picker, and an optional Google Calendar preview.

This repository contains source snapshots for review. Use a link to a specific commit when reporting a finding or recording which version you reviewed.

## Build and review

Check out the revision you want to review. With Node.js 22.13 or later on the 22.x line or Node.js 24 or later, run:

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm ci
npm run lint
npm run test:unit
npm run build:local
```

The build verifies the extension manifest and produces `dist/` and `arcify-extension.zip`. To try it, open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked**, and choose `dist/`. Use a disposable Chrome profile with synthetic data for evaluation.

## Permissions and data use

The [privacy policy](PRIVACY.md) describes how PrismArc uses browser data.

- **Tabs and bookmarks.** PrismArc uses Chrome's tab and bookmark APIs to organize spaces, favorites, and saved tabs. Chrome grants access to profile bookmarks. Chrome's own profile sync settings can sync those bookmarks. Extension settings and saved state use local or session storage.
- **Quick Switcher.** The switcher searches open tabs, bookmarks, and browsing history locally without maintaining a separate search index. The history permission also allows writes. Choosing **Delete from browser history** on a history result removes all visits to the exact URLs represented by that result. There is no undo for history deletion. Selecting **Search Google** sends the typed query to Google through browser navigation.
- **Tab previews.** On macOS, invoking the recent-tab picker can capture the foreground page using the current-tab grant. **Enable previews as I browse** requests optional all-sites access to capture visible pages during normal browsing. Captures can include embedded page content. PrismArc excludes private windows from capture and keeps up to five thumbnails in browser-session memory for up to ten minutes, without uploading them.
- **Google Calendar.** Calendar preview uses optional Chrome identity permission and requires explicit Google sign-in. Once connected, opening or refreshing the preview fetches today's primary calendar events directly from Google. The OAuth scope permits reading events on calendars owned by the chosen account. PrismArc displays titles and times, keeps event data in memory, and stores the short-lived token in browser-session storage. **Disconnect** clears local access and asks Google to revoke the session token. The **+** action opens Google's event editor in a tab.
- **Other permissions.** Tab groups support optional mirroring of spaces into Chrome groups. The extension uses alarms for optional idle-tab archiving and preview expiry, browser-provided favicons for tab icons, and a write-only clipboard helper to copy the active URL on request. Debug logging is off by default and can include browsing metadata when enabled.

For an organizational pilot, keep Calendar disconnected and **Enable previews as I browse** off until the relevant administrators and security reviewers approve them. Calendar sign-in requires a configured OAuth client and validation against the intended browser and account policies.

The [extension manifest](manifest.json) lists the complete permission set. For the main data paths, see [history search and deletion](quick-switcher-search.js), [tab previews](tab-switcher-previews.js), [Calendar authorization](calendar-auth.js), and [Calendar requests](calendar-events.js).

## License

Prismark is distributed under the [GNU General Public License v3.0](LICENSE), which allows use, modification, and redistribution under its terms. The [modification notice](NOTICE) records changes from Arcify. If you distribute a modified version, retain copyright and license notices, identify and date your changes, and provide the corresponding source under GPLv3 if you distribute a built package.
