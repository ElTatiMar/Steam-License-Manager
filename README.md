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
- **Quick Filter Tabs**:
  - **All**: View all removable licenses found on your account.
  - **Demos & Trailers**: Filter items matching demo, trailer, teaser, PEGI, or ESRB keywords.
  - **Selected**: View only the licenses you have checked for bulk removal.
- **Single & Bulk Removal**: Remove a single license with one click or select multiple licenses (with **Select All** support for the active filter) and remove them sequentially.
- **Activate Steam Key(s)**: Open a popup to enter one or more Steam keys (one per line), validate each line against `AAAAA-BBBBB-CCCCC`, uppercase each key, and open `https://store.steampowered.com/account/registerkey?key={KEY}` in a new tab per key.
- **Export to `.TXT` & `.CSV`**: Export your selected or currently filtered licenses to a plain-text (`.txt`) or spreadsheet-ready (`.csv`) file with one click.
- **Built-in Rate-Limit & Session Handling**:
  - Verifies an active Steam login session (`g_sessionID`) before scanning or removing.
  - Spaces requests with a `1000ms` delay to be gentle on Steam's servers.
  - Automatically detects Steam rate-limiting (`success === 84`), pauses for 10 minutes before retrying, and allows you to cancel at any time via the **Stop** button.
- **Live Activity Log & Console API**: Displays timestamped logs directly in the UI panel and exposes `window.SteamLicenseManager` for programmatic use in DevTools.

---

## How to Use

1. Open your browser and log in to [https://store.steampowered.com](https://store.steampowered.com) (or navigate directly to [https://store.steampowered.com/account/licenses](https://store.steampowered.com/account/licenses)).
2. Open your browser's **Developer Tools**:
   - **Windows / Linux**: Press `F12` or `Ctrl + Shift + I`
   - **macOS**: Press `Cmd + Option + I`
3. Switch to the **Console** tab.
4. Copy the entire contents of [`steam-license-manager.js`](./steam-license-manager.js), paste it into the console, and press **Enter**.
5. The **Steam License Manager** modal will appear. Click **Scan Licenses** to scan your account licenses (or immediately use **Activate Key(s)** or direct ID removal).

---

## Using the Interface

| Control | Description |
| :--- | :--- |
| **Search Input** | Filter scanned licenses by numeric ID (`12345`), multiple IDs (`12345, 67890`), or license title. |
| **Remove ID(s) Directly** | Appears automatically when numeric IDs are typed in the search box; removes those IDs immediately. |
| **All / Demos & Trailers / Selected** | Quick filter tabs to narrow down the displayed license list. |
| **Activate Key(s)** | Opens a popup to input one Steam key per line (`AAAAA-BBBBB-CCCCC`), validates each line, and opens a registration tab per key. |
| **Scan Licenses / Rescan Licenses** | Fetches (or re-fetches) your account's license pages from Steam when clicked. |
| **Select All Checkbox** | Located in the table header; selects or deselects all licenses matching the current search/filter. |
| **Remove (Row Button)** | Immediately removes that specific license from your account. |
| **Export .TXT / Export .CSV** | Downloads a `.txt` or `.csv` file of checked licenses (if any are selected) or all currently filtered licenses. |
| **Remove Selected (N)** | Removes all currently checked licenses sequentially. |
| **Stop** | Safely aborts an active scan or bulk removal operation. |
| **`_` / `✕` (Header)** | Minimize the panel to the bottom-right corner or close it completely. |

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

// Export licenses as .txt or .csv (scope: "auto" | "selected" | "filtered" | "all")
SteamLicenseManager.exportTxt();
SteamLicenseManager.exportCsv("all");

// Open the Activate Key(s) popup or activate keys directly via console
SteamLicenseManager.openActivateKeysPopup();
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
