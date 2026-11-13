# Steam License Manager

A browser console script that injects an interactive management panel onto the Steam Store, allowing you to scan your account's removable licenses, search by specific **AppId / Package ID** or **License Name**, and remove individual or multiple licenses in bulk.

---

## Features

- **Interactive Steam-Themed UI Modal**: Injects an overlay panel directly on `store.steampowered.com` with minimize, close, and live status controls.
- **Automatic License Scanner**: Fetches and paginates through your [Steam Account Licenses](https://store.steampowered.com/account/licenses/) to list all removable free/complimentary licenses along with their Package ID, title, and acquisition date.
- **Flexible Search**:
  - Search by **AppId / Package ID** (single ID like `12345` or multiple comma/space-separated IDs like `12345, 67890`).
  - Search by **License Name** or acquisition keyword (case-insensitive).
- **Direct ID Removal**: Enter one or more numeric IDs into the search bar to immediately reveal a **Remove ID(s) Directly** action—allowing you to remove specific IDs even without waiting for a full scan.
- **Quick Filter Tabs & Sortable Columns**:
  - **All / Demos & Trailers / Selected**: Filter tabs to narrow down the displayed license list.
  - **Sortable Headers**: Click **AppId / PkgID**, **License Name**, or **Date** to sort ascending (`▲`), descending (`▼`), or reset to scan order (`⇅`).
- **Single & Bulk Removal with Permanent Confirmation**: Remove a single license, direct ID(s), or multiple selected licenses sequentially, with a confirmation dialog previewing the target items and warning that license removal is permanent and irreversible.
- **Activate Steam Key(s) (Direct AJAX & Tab Modes)**:
  - Validate keys line-by-line against `AAAAA-BBBBB-CCCCC`.
  - **Activate Directly (No Tabs)**: Redeems keys in the background via Steam's `/account/ajaxregisterkey/` endpoint, logging the redeemed product title or exact error code without opening new tabs.
  - **Open in New Tabs**: Opens `https://store.steampowered.com/account/registerkey?key={KEY}` in a new tab per key.
- **Export to `.TXT` & `.CSV`**: Export your selected or currently filtered licenses to a plain-text (`.txt`) or spreadsheet-ready (`.csv`) file with one click.
- **Built-in Rate-Limit Countdown & Session Handling**:
  - Verifies an active Steam login session (`g_sessionID`) before scanning or removing.
  - Spaces requests with a `1000ms` delay to be gentle on Steam's servers.
  - Automatically detects Steam rate-limiting (`success === 84`), pauses for 10 minutes with a live `MM:SS` countdown in the status bar before retrying, and allows instant cancellation via the **Stop** button.
- **Userscript & Console Compatible**: Includes a standard `// ==UserScript==` header for Tampermonkey/Violentmonkey installation (with a floating **Steam License Manager** launcher button) and works directly when pasted into the browser DevTools console.
- **Live Activity Log & Console API**: Displays timestamped logs directly in the UI panel and exposes `window.SteamLicenseManager` for programmatic use in DevTools.

---

## How to Use

### Option A: Browser Console
1. Open your browser and log in to [https://store.steampowered.com](https://store.steampowered.com) (or navigate directly to [https://store.steampowered.com/account/licenses](https://store.steampowered.com/account/licenses)).
2. Open your browser's **Developer Tools**:
   - **Windows / Linux**: Press `F12` or `Ctrl + Shift + I`
   - **macOS**: Press `Cmd + Option + I`
3. Switch to the **Console** tab.
4. Copy the entire contents of [`steam-license-manager.js`](./steam-license-manager.js), paste it into the console, and press **Enter**.
5. The **Steam License Manager** modal will appear. Click **Scan Licenses** to scan your account licenses (or immediately use **Activate Key(s)** or direct ID removal).

### Option B: Userscript (Tampermonkey / Violentmonkey)
1. Install [`steam-license-manager.js`](./steam-license-manager.js) as a userscript in Tampermonkey or Violentmonkey.
2. Visit [`https://store.steampowered.com/account/licenses/`](https://store.steampowered.com/account/licenses/) (where the panel opens automatically) or any `store.steampowered.com` page and click the floating **Steam License Manager** button in the bottom-right corner.

---

## Using the Interface

| Control | Description |
| :--- | :--- |
| **Search Input** | Filter scanned licenses by numeric ID (`12345`), multiple IDs (`12345, 67890`), or license title. |
| **Remove ID(s) Directly** | Appears automatically when numeric IDs are typed in the search box; opens the permanent removal confirmation dialog for those IDs. |
| **All / Demos & Trailers / Selected** | Quick filter tabs to narrow down the displayed license list. |
| **Column Headers (`AppId / PkgID`, `License Name`, `Date`)** | Click any header to sort ascending (`▲`), descending (`▼`), or reset to original scan order (`⇅`). |
| **Activate Key(s)** | Opens a popup to input one Steam key per line (`AAAAA-BBBBB-CCCCC`), validates each line, and lets you either **Activate Directly (No Tabs)** via AJAX or **Open in New Tabs**. |
| **Scan Licenses / Rescan Licenses** | Fetches (or re-fetches) your account's license pages from Steam when clicked. |
| **Select All Checkbox** | Located in the table header; selects or deselects all licenses matching the current search/filter. |
| **Remove (Row Button)** | Opens the permanent removal confirmation dialog and removes that specific license from your account. |
| **Export .TXT / Export .CSV** | Downloads a `.txt` or `.csv` file of checked licenses (if any are selected) or all currently filtered licenses. |
| **Remove Selected (N)** | Opens a confirmation dialog warning that license removal is permanent and irreversible, then removes all checked licenses sequentially upon confirmation. |
| **Stop** | Safely aborts an active scan, countdown, AJAX key batch, or bulk removal operation. |
| **`_` / `✕` (Header)** | Minimize the panel to the bottom-right corner or close it (leaving a floating **Steam License Manager** launcher button). |

---

## Console API

When loaded, the script also attaches `window.SteamLicenseManager` for use directly from the DevTools console:

```js
// Re-open the UI panel if closed
SteamLicenseManager.open();

// Scan / rescan account licenses
await SteamLicenseManager.populate();

// Filter the UI and return matching license objects
SteamLicenseManager.search("12345");
SteamLicenseManager.search("demo");

// Toggle sort column ("id" | "name" | "date")
SteamLicenseManager.toggleSort("name");

// Export licenses as .txt or .csv (scope: "auto" | "selected" | "filtered" | "all")
SteamLicenseManager.exportTxt();
SteamLicenseManager.exportCsv("all");

// Open the Activate Key(s) popup or activate keys via AJAX or tabs
SteamLicenseManager.openActivateKeysPopup();
await SteamLicenseManager.activateKeysAjax("AAAAA-BBBBB-CCCCC\n12345-ABCDE-67890");
SteamLicenseManager.activateKeys("AAAAA-BBBBB-CCCCC\n12345-ABCDE-67890");

// Remove specific Package / AppIds directly via console
await SteamLicenseManager.removePackages(["12345", "67890"]);

// Inspect internal state (scanned licenses, selected IDs, flags)
SteamLicenseManager.getState();
```

---

## Notes & Limitations

- **Removable Licenses Only**: Steam's `/account/removelicense` endpoint only supports removing complimentary/free licenses (those that have a `Remove` link on your Steam licenses page). Purchased retail/store games cannot be removed via this endpoint.
- **Multi-Key Tab Opening & Pop-up Blockers**: Modern browsers allow a single click to open only 1 new tab by default unless pop-ups are allowed for the site. When activating multiple keys at once, if the browser blocks the 2nd+ tabs, the popup stays open with the remaining keys and one-click links—or you can allow pop-ups for `https://store.steampowered.com` in your browser's address bar to open all tabs simultaneously in a single click.
- **Rate Limits**: Steam restricts how many licenses can be removed in a short window. If Steam responds with status code `84` (rate limit exceeded), the script will log a warning and wait 10 minutes before retrying, or you can click **Stop** to cancel.

---

## License

This project is licensed under the [GNU General Public License v3.0](./LICENSE).
