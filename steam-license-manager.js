/**
 * Steam License Manager
 * Based on steam-demo-cleaner.js
 *
 * Run this script in the browser console while logged into https://store.steampowered.com
 * It injects an interactive UI panel allowing you to scan your account licenses,
 * search for specific Steam AppIds / Package IDs or license names, and remove them.
 */

(function () {
    "use strict";

    const MODAL_ID = "steam-license-manager-overlay";
    const STYLE_ID = "steam-license-manager-styles";
    const DEMO_REGEX = /\b(?:trailer|teaser|demo|pegi|esrb)\b/i;

    // State
    const state = {
        licenses: [], // Array of { id, name, date, acquisition, isDemo, removed }
        selectedIds: new Set(),
        searchQuery: "",
        filterMode: "all", // "all" | "demo" | "selected"
        isScanning: false,
        isRemoving: false,
        abortRequested: false,
    };

    /**
     * Check if user is logged into Steam in the current window context
     */
    function checkSession() {
        return (
            typeof window !== "undefined" &&
            Boolean(window.g_sessionID) &&
            ((window.g_steamID && window.g_steamID !== "0" && window.g_steamID !== false) ||
                (typeof window.g_AccountID !== "undefined" && window.g_AccountID !== 0))
        );
    }

    /**
     * Log helper that writes to both DevTools console and the UI log panel
     */
    function logMessage(message, type = "info") {
        console.log(`[Steam License Manager] ${message}`);
        const logContainer = document.getElementById("slm-log-output");
        if (logContainer) {
            const entry = document.createElement("div");
            entry.className = `slm-log-entry slm-log-${type}`;
            const time = new Date().toLocaleTimeString();
            entry.textContent = `[${time}] ${message}`;
            logContainer.appendChild(entry);
            logContainer.scrollTop = logContainer.scrollHeight;
        }
        const statusText = document.getElementById("slm-status-text");
        if (statusText) {
            statusText.textContent = message;
        }
    }

    /**
     * Scan Steam account licenses pages and collect all removable licenses
     */
    async function populate(onProgress) {
        if (!checkSession()) {
            logMessage(
                "No active Steam session detected. Please log in to your Steam account on store.steampowered.com and re-run the script.",
                "error"
            );
            return null;
        }

        const licenses = [];
        const seenIds = new Set();
        let nextHref = "";
        let hasMorePages = true;
        let count = 0;
        let pageNum = 1;

        state.isScanning = true;
        state.abortRequested = false;
        updateControlsState();

        logMessage("Scanning licenses pages...");

        while (hasMorePages && !state.abortRequested) {
            logMessage(`Fetching page ${pageNum}...`);
            try {
                const url = `https://store.steampowered.com/account/licenses/${nextHref}`;
                const response = await fetch(url, { credentials: "include" });

                // Check if redirected to login or unauthorized (session missing / expired)
                if (
                    (response.redirected &&
                        (response.url.includes("/login") || response.url.includes("login.steampowered.com"))) ||
                    response.status === 401 ||
                    response.status === 403
                ) {
                    const msg =
                        pageNum === 1
                            ? "No active Steam session detected. Please log in to your Steam account and re-run the script."
                            : "Steam session has expired. Please log in again and re-run the script.";
                    logMessage(msg, "error");
                    state.isScanning = false;
                    updateControlsState();
                    return null;
                }

                if (!response.ok) {
                    logMessage(`Error fetching page ${pageNum}: ${response.status} - ${response.statusText}`, "error");
                    break;
                }

                const text = await response.text();
                const doc = new DOMParser().parseFromString(text, "text/html");
                const table = doc.querySelector(".account_table");

                if (!table) {
                    // Check if Steam returned a login page instead of the licenses table
                    if (
                        text.includes("login.steampowered.com") ||
                        text.includes('id="login_btn"') ||
                        doc.querySelector("#loginForm") ||
                        doc.querySelector("input[type='password']") ||
                        (doc.querySelector(".global_action_link") && !doc.querySelector(".account_pulldown"))
                    ) {
                        const msg =
                            pageNum === 1
                                ? "No active Steam session detected. Please log in to your Steam account and re-run the script."
                                : "Steam session has expired. Please log in again and re-run the script.";
                        logMessage(msg, "error");
                        state.isScanning = false;
                        updateControlsState();
                        return null;
                    }
                    break;
                }

                const rows = table.rows;

                for (const row of rows) {
                    if (row.cells.length < 2) continue;

                    const dateCell = row.cells[0];
                    const itemCell = row.cells[1];
                    const acquisitionCell = row.cells[2];

                    const packageIdMatch = /RemoveFreeLicense\s*\(\s*(\d+)/.exec(itemCell.innerHTML);

                    if (packageIdMatch !== null) {
                        const packageId = packageIdMatch[1];
                        if (!seenIds.has(packageId)) {
                            seenIds.add(packageId);
                            count++;

                            // Extract clean license name without the "Remove" link text
                            const clonedCell = itemCell.cloneNode(true);
                            const removeLinkDiv = clonedCell.querySelector(".free_license_remove_link");
                            if (removeLinkDiv) {
                                removeLinkDiv.remove();
                            }
                            const rawText = clonedCell.textContent || itemCell.textContent || "";
                            const name = rawText
                                .replace(/^\s*Remove\s*/i, "")
                                .trim()
                                .replace(/[\r\n\t]+/g, " ");

                            const date = (dateCell ? dateCell.textContent : "").trim().replace(/[\r\n\t]+/g, " ");
                            const acquisition = (acquisitionCell ? acquisitionCell.textContent : "")
                                .trim()
                                .replace(/[\r\n\t]+/g, " ");

                            const item = {
                                id: packageId,
                                name: name || `License #${packageId}`,
                                date,
                                acquisition,
                                isDemo: DEMO_REGEX.test(name),
                                removed: false,
                            };

                            licenses.push(item);
                        }
                    }
                }

                if (typeof onProgress === "function") {
                    onProgress(licenses);
                }

                const nextLink = doc.querySelector(".license_paginator_next");
                if (!nextLink) {
                    hasMorePages = false;
                } else {
                    nextHref = nextLink.getAttribute("href");
                    pageNum++;
                    // Add a small delay to avoid rate limiting
                    await new Promise((r) => setTimeout(r, 250));
                }
            } catch (e) {
                console.error("Error fetching page:", e);
                logMessage(`Error fetching page: ${e.message || e}`, "error");
                hasMorePages = false;
            }
        }

        state.isScanning = false;
        state.licenses = licenses;
        updateControlsState();
        renderLicenseList();

        if (state.abortRequested) {
            logMessage(`Scan stopped. Found ${licenses.length} removable licenses so far.`, "warn");
        } else {
            logMessage(`Finished scanning. Found ${licenses.length} removable licenses.`, "success");
        }

        return licenses;
    }

    /**
     * Remove an array of Steam Package/AppIds from the user's account
     */
    async function removePackages(appIds) {
        if (!appIds || appIds.length === 0) {
            logMessage("No AppIds provided to remove.", "warn");
            return false;
        }

        if (!checkSession()) {
            logMessage("No active Steam session detected. Please log in to your Steam account.", "error");
            return false;
        }

        state.isRemoving = true;
        state.abortRequested = false;
        updateControlsState();

        let retryCount = 0;
        let removedCount = 0;

        for (let i = 0; i < appIds.length; ) {
            if (state.abortRequested) {
                logMessage(`Removal stopped by user (${removedCount}/${appIds.length} removed).`, "warn");
                state.isRemoving = false;
                updateControlsState();
                return false;
            }

            const currentId = String(appIds[i]).trim();
            const licenseObj = state.licenses.find((item) => item.id === currentId);
            const label = licenseObj ? `${currentId} (${licenseObj.name})` : currentId;

            try {
                const response = await fetch("https://store.steampowered.com/account/removelicense", {
                    headers: {
                        accept: "*/*",
                        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    },
                    body: `sessionid=${encodeURIComponent(window.g_sessionID)}&packageid=${encodeURIComponent(currentId)}`,
                    method: "POST",
                    mode: "cors",
                    credentials: "include",
                });

                // Check if redirected to login (session expired)
                if (
                    (response.redirected &&
                        (response.url.includes("/login") || response.url.includes("login.steampowered.com"))) ||
                    response.status === 401 ||
                    response.status === 403
                ) {
                    logMessage("Steam session has expired. Please log in again and re-run the script.", "error");
                    state.isRemoving = false;
                    updateControlsState();
                    return false;
                }

                if (response.status !== 200) {
                    logMessage(`Error removing ${label}: ${response.status} - ${response.statusText}`, "error");
                    i++;
                    retryCount = 0;
                    continue;
                }

                const text = await response.text();
                let data;

                try {
                    data = JSON.parse(text);
                } catch {
                    // If Steam returned HTML instead of JSON, the session has expired
                    if (text.trim().startsWith("<") || text.includes("login")) {
                        logMessage("Steam session has expired. Please log in again and re-run the script.", "error");
                        state.isRemoving = false;
                        updateControlsState();
                        return false;
                    }
                    logMessage(`Failed to parse response for ${label}`, "error");
                    i++;
                    retryCount = 0;
                    continue;
                }

                // Check if Steam JSON response indicated login is required
                if (data.requires_login) {
                    logMessage("Steam session has expired. Please log in again and re-run the script.", "error");
                    state.isRemoving = false;
                    updateControlsState();
                    return false;
                }

                // Steam uses 84 for rate limiting
                if (data.success === 84) {
                    logMessage(`Rate limited on ${label}. Waiting 10 minutes before retrying...`, "warn");
                    await waitWithCancel(600000);
                    // Retry same index by not incrementing i
                } else if (data.success === 1 || data.success === true) {
                    removedCount++;
                    logMessage(`Removed: ${label} (${i + 1}/${appIds.length})`, "success");

                    if (licenseObj) {
                        licenseObj.removed = true;
                    }
                    state.selectedIds.delete(currentId);
                    renderLicenseList();

                    // Add a small delay between requests to be gentle on Steam's API
                    if (i + 1 < appIds.length) {
                        await waitWithCancel(1000);
                    }
                    i++;
                    retryCount = 0;
                } else {
                    logMessage(`Failed to remove ${label}: Unknown error (success = ${data.success})`, "error");
                    i++;
                    retryCount = 0;
                }
            } catch (e) {
                logMessage(`Exception during removal of ${label}: ${e.message || e}`, "error");
                retryCount++;
                if (retryCount >= 3) {
                    logMessage(`Skipping ${label} after 3 failed attempts.`, "warn");
                    i++;
                    retryCount = 0;
                } else {
                    // Add a 5 second delay before retrying
                    await waitWithCancel(5000);
                }
            }
        }

        state.isRemoving = false;
        updateControlsState();
        renderLicenseList();
        logMessage(`Finished removal process. Removed ${removedCount}/${appIds.length} specified AppIds from account.`, "success");
        return true;
    }

    /**
     * Wait helper that checks abortRequested every 250ms
     */
    async function waitWithCancel(ms) {
        const step = 250;
        let elapsed = 0;
        while (elapsed < ms && !state.abortRequested) {
            await new Promise((r) => setTimeout(r, Math.min(step, ms - elapsed)));
            elapsed += step;
        }
    }

    /**
     * Filter licenses based on the search query (AppId or Name) and active filter mode
     */
    function getFilteredLicenses() {
        const rawQuery = state.searchQuery.trim();
        const lowerQuery = rawQuery.toLowerCase();

        // Check if query looks like a comma/space separated list of numeric IDs
        const idTokens = rawQuery
            .split(/[\s,]+/)
            .map((t) => t.trim())
            .filter(Boolean);
        const isMultiIdSearch = idTokens.length > 1 && idTokens.every((t) => /^\d+$/.test(t));

        return state.licenses.filter((item) => {
            if (item.removed) return false;

            if (state.filterMode === "demo" && !item.isDemo) return false;
            if (state.filterMode === "selected" && !state.selectedIds.has(item.id)) return false;

            if (!rawQuery) return true;

            if (isMultiIdSearch) {
                return idTokens.some((token) => item.id.includes(token));
            }

            return (
                item.id.includes(rawQuery) ||
                item.name.toLowerCase().includes(lowerQuery) ||
                item.acquisition.toLowerCase().includes(lowerQuery)
            );
        });
    }

    /**
     * Inject CSS styles for the Steam License Manager UI
     */
    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            #${MODAL_ID} {
                position: fixed;
                inset: 0;
                z-index: 999999;
                background: rgba(0, 0, 0, 0.72);
                display: flex;
                align-items: center;
                justify-content: center;
                font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
                color: #c7d5e0;
                backdrop-filter: blur(2px);
            }
            #${MODAL_ID}.slm-minimized {
                inset: auto 20px 20px auto;
                background: transparent;
                backdrop-filter: none;
            }
            .slm-panel {
                width: min(920px, 95vw);
                max-height: 88vh;
                background: linear-gradient(180deg, #1b2838 0%, #171a21 100%);
                border: 1px solid #2a475e;
                border-radius: 6px;
                box-shadow: 0 16px 48px rgba(0, 0, 0, 0.85);
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }
            #${MODAL_ID}.slm-minimized .slm-panel {
                width: 360px;
                max-height: none;
            }
            #${MODAL_ID}.slm-minimized .slm-body,
            #${MODAL_ID}.slm-minimized .slm-footer {
                display: none;
            }
            .slm-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 14px 18px;
                background: #171a21;
                border-bottom: 1px solid #2a475e;
            }
            .slm-title-wrap {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .slm-title {
                font-size: 16px;
                font-weight: 600;
                color: #ffffff;
                letter-spacing: 0.3px;
                margin: 0;
            }
            .slm-badge {
                font-size: 11px;
                padding: 2px 8px;
                border-radius: 3px;
                background: #2a475e;
                color: #66c0f4;
                font-weight: 500;
            }
            .slm-header-actions {
                display: flex;
                gap: 6px;
            }
            .slm-icon-btn {
                background: #2a475e;
                border: 1px solid #3b617f;
                color: #c7d5e0;
                border-radius: 3px;
                padding: 4px 10px;
                cursor: pointer;
                font-size: 12px;
                transition: background 0.15s, color 0.15s;
            }
            .slm-icon-btn:hover {
                background: #3b617f;
                color: #ffffff;
            }
            .slm-body {
                padding: 16px 18px;
                display: flex;
                flex-direction: column;
                gap: 12px;
                overflow: hidden;
                flex: 1;
            }
            .slm-toolbar {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
                align-items: center;
            }
            .slm-search-wrap {
                position: relative;
                flex: 1;
                min-width: 240px;
                display: flex;
                gap: 6px;
            }
            .slm-input {
                flex: 1;
                background: #101822;
                border: 1px solid #2a475e;
                border-radius: 3px;
                padding: 8px 12px;
                color: #ffffff;
                font-size: 13px;
                outline: none;
            }
            .slm-input:focus {
                border-color: #66c0f4;
                box-shadow: 0 0 0 1px rgba(102, 192, 244, 0.3);
            }
            .slm-input::placeholder {
                color: #677786;
            }
            .slm-filter-group {
                display: flex;
                gap: 4px;
                background: #101822;
                padding: 3px;
                border-radius: 4px;
                border: 1px solid #2a475e;
            }
            .slm-filter-btn {
                background: transparent;
                border: none;
                color: #8f98a0;
                padding: 5px 10px;
                border-radius: 3px;
                cursor: pointer;
                font-size: 12px;
                transition: all 0.15s;
            }
            .slm-filter-btn:hover {
                color: #ffffff;
            }
            .slm-filter-btn.active {
                background: #2a475e;
                color: #66c0f4;
                font-weight: 600;
            }
            .slm-btn {
                background: #2a475e;
                border: 1px solid #3b617f;
                color: #ffffff;
                padding: 7px 13px;
                border-radius: 3px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                transition: background 0.15s, opacity 0.15s;
                white-space: nowrap;
            }
            .slm-btn:hover:not(:disabled) {
                background: #3d6c91;
            }
            .slm-btn:disabled {
                opacity: 0.45;
                cursor: not-allowed;
            }
            .slm-btn-primary {
                background: linear-gradient(90deg, #47bfff 0%, #1a44c2 100%);
                border-color: #47bfff;
            }
            .slm-btn-primary:hover:not(:disabled) {
                background: linear-gradient(90deg, #5cc8ff 0%, #2654d9 100%);
            }
            .slm-btn-danger {
                background: #8b2626;
                border-color: #b83b3b;
            }
            .slm-btn-danger:hover:not(:disabled) {
                background: #a82e2e;
            }
            .slm-btn-sm {
                padding: 3px 8px;
                font-size: 11px;
            }
            .slm-direct-bar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                background: rgba(42, 71, 94, 0.35);
                border: 1px solid #2a475e;
                border-radius: 4px;
                padding: 8px 12px;
                font-size: 12px;
            }
            .slm-table-container {
                flex: 1;
                min-height: 240px;
                max-height: 42vh;
                overflow-y: auto;
                border: 1px solid #2a475e;
                border-radius: 4px;
                background: #101822;
            }
            .slm-table {
                width: 100%;
                border-collapse: collapse;
                font-size: 13px;
            }
            .slm-table th {
                position: sticky;
                top: 0;
                background: #171a21;
                color: #8f98a0;
                text-align: left;
                padding: 9px 10px;
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                border-bottom: 1px solid #2a475e;
                z-index: 1;
            }
            .slm-table td {
                padding: 8px 10px;
                border-bottom: 1px solid rgba(42, 71, 94, 0.35);
                vertical-align: middle;
            }
            .slm-table tr:hover td {
                background: rgba(102, 192, 244, 0.08);
            }
            .slm-table tr.slm-row-selected td {
                background: rgba(102, 192, 244, 0.15);
            }
            .slm-id-pill {
                font-family: Consolas, monospace;
                color: #66c0f4;
                background: rgba(102, 192, 244, 0.12);
                padding: 2px 6px;
                border-radius: 3px;
                font-size: 12px;
                user-select: all;
            }
            .slm-demo-tag {
                font-size: 10px;
                background: rgba(164, 208, 7, 0.18);
                color: #a4d007;
                padding: 1px 5px;
                border-radius: 3px;
                margin-left: 6px;
                vertical-align: middle;
            }
            .slm-empty {
                padding: 36px 16px;
                text-align: center;
                color: #677786;
                font-size: 13px;
            }
            .slm-log-box {
                background: #0d121a;
                border: 1px solid #22384b;
                border-radius: 4px;
                height: 95px;
                overflow-y: auto;
                padding: 6px 10px;
                font-family: Consolas, monospace;
                font-size: 11px;
                line-height: 1.45;
            }
            .slm-log-entry {
                color: #9fb2c4;
            }
            .slm-log-success {
                color: #a4d007;
            }
            .slm-log-warn {
                color: #e5b54f;
            }
            .slm-log-error {
                color: #ff6b6b;
            }
            .slm-footer {
                padding: 12px 18px;
                background: #171a21;
                border-top: 1px solid #2a475e;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
            }
            .slm-status {
                font-size: 12px;
                color: #8f98a0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .slm-footer-actions {
                display: flex;
                gap: 8px;
                align-items: center;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Escape HTML special characters
     */
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    /**
     * Render the filtered license rows in the table
     */
    function renderLicenseList() {
        const tbody = document.getElementById("slm-table-body");
        const countBadge = document.getElementById("slm-count-badge");
        const selectAllCheckbox = document.getElementById("slm-select-all");
        const removeSelectedBtn = document.getElementById("slm-remove-selected-btn");
        const directBar = document.getElementById("slm-direct-remove-bar");
        const directIdLabel = document.getElementById("slm-direct-id-label");

        if (!tbody) return;

        const activeLicenses = state.licenses.filter((l) => !l.removed);
        const filtered = getFilteredLicenses();

        if (countBadge) {
            countBadge.textContent = `${filtered.length} / ${activeLicenses.length} Licenses (${state.selectedIds.size} selected)`;
        }

        if (removeSelectedBtn) {
            removeSelectedBtn.textContent = `Remove Selected (${state.selectedIds.size})`;
            removeSelectedBtn.disabled =
                state.selectedIds.size === 0 || state.isScanning || state.isRemoving;
        }

        // Show direct AppId removal helper if user typed one or more numeric IDs
        const rawQuery = state.searchQuery.trim();
        const directIds = rawQuery
            .split(/[\s,]+/)
            .map((t) => t.trim())
            .filter((t) => /^\d+$/.test(t));

        if (directBar && directIdLabel) {
            if (directIds.length > 0) {
                directBar.style.display = "flex";
                directIdLabel.textContent = directIds.join(", ");
            } else {
                directBar.style.display = "none";
            }
        }

        if (selectAllCheckbox) {
            selectAllCheckbox.checked =
                filtered.length > 0 && filtered.every((item) => state.selectedIds.has(item.id));
            selectAllCheckbox.indeterminate =
                filtered.some((item) => state.selectedIds.has(item.id)) && !selectAllCheckbox.checked;
        }

        if (filtered.length === 0) {
            const emptyMsg = state.isScanning
                ? "Scanning your Steam account licenses..."
                : activeLicenses.length === 0
                ? 'No removable licenses loaded yet. Click "Scan Licenses" or enter an AppId / Package ID above.'
                : "No licenses match your current search filter.";
            tbody.innerHTML = `<tr><td colspan="5" class="slm-empty">${escapeHtml(emptyMsg)}</td></tr>`;
            return;
        }

        const rowsHtml = filtered
            .map((item) => {
                const isSelected = state.selectedIds.has(item.id);
                const demoBadge = item.isDemo ? '<span class="slm-demo-tag">DEMO / TRAILER</span>' : "";
                const disabledAttr = state.isScanning || state.isRemoving ? "disabled" : "";
                return `
                    <tr class="${isSelected ? "slm-row-selected" : ""}" data-id="${escapeHtml(item.id)}">
                        <td style="width: 32px; text-align: center;">
                            <input type="checkbox" class="slm-row-checkbox" data-id="${escapeHtml(item.id)}" ${
                    isSelected ? "checked" : ""
                } ${disabledAttr} />
                        </td>
                        <td style="width: 110px;">
                            <span class="slm-id-pill">${escapeHtml(item.id)}</span>
                        </td>
                        <td>
                            <span>${escapeHtml(item.name)}</span>${demoBadge}
                        </td>
                        <td style="width: 120px; color: #8f98a0; font-size: 12px;">
                            ${escapeHtml(item.date || "-")}
                        </td>
                        <td style="width: 85px; text-align: right;">
                            <button class="slm-btn slm-btn-danger slm-btn-sm slm-single-remove-btn" data-id="${escapeHtml(
                                item.id
                            )}" ${disabledAttr}>
                                Remove
                            </button>
                        </td>
                    </tr>
                `;
            })
            .join("");

        tbody.innerHTML = rowsHtml;
    }

    /**
     * Enable / disable buttons according to scanning / removing state
     */
    function updateControlsState() {
        const scanBtn = document.getElementById("slm-scan-btn");
        const stopBtn = document.getElementById("slm-stop-btn");
        const removeSelectedBtn = document.getElementById("slm-remove-selected-btn");
        const directRemoveBtn = document.getElementById("slm-direct-remove-btn");

        const busy = state.isScanning || state.isRemoving;

        if (scanBtn) {
            scanBtn.disabled = busy;
            scanBtn.textContent = state.isScanning ? "Scanning..." : "Rescan Licenses";
        }
        if (stopBtn) {
            stopBtn.style.display = busy ? "inline-block" : "none";
        }
        if (removeSelectedBtn) {
            removeSelectedBtn.disabled = busy || state.selectedIds.size === 0;
        }
        if (directRemoveBtn) {
            directRemoveBtn.disabled = busy;
        }
    }

    /**
     * Create and mount the UI Modal on the page
     */
    function createUI() {
        injectStyles();

        const existing = document.getElementById(MODAL_ID);
        if (existing) {
            existing.remove();
        }

        const overlay = document.createElement("div");
        overlay.id = MODAL_ID;

        overlay.innerHTML = `
            <div class="slm-panel" role="dialog" aria-label="Steam License Manager">
                <div class="slm-header">
                    <div class="slm-title-wrap">
                        <h2 class="slm-title">Steam License Manager</h2>
                        <span id="slm-count-badge" class="slm-badge">0 Licenses</span>
                    </div>
                    <div class="slm-header-actions">
                        <button id="slm-minimize-btn" class="slm-icon-btn" title="Minimize / Expand">_</button>
                        <button id="slm-close-btn" class="slm-icon-btn" title="Close">✕</button>
                    </div>
                </div>

                <div class="slm-body">
                    <div class="slm-toolbar">
                        <div class="slm-search-wrap">
                            <input
                                id="slm-search-input"
                                type="text"
                                class="slm-input"
                                placeholder="Search by Steam AppId / Package ID (e.g. 12345) or License Name..."
                                autocomplete="off"
                            />
                            <button id="slm-clear-search-btn" class="slm-btn" title="Clear search">Clear</button>
                        </div>

                        <div class="slm-filter-group">
                            <button class="slm-filter-btn active" data-filter="all">All</button>
                            <button class="slm-filter-btn" data-filter="demo">Demos &amp; Trailers</button>
                            <button class="slm-filter-btn" data-filter="selected">Selected</button>
                        </div>

                        <button id="slm-scan-btn" class="slm-btn slm-btn-primary">Rescan Licenses</button>
                    </div>

                    <div id="slm-direct-remove-bar" class="slm-direct-bar" style="display: none;">
                        <span>
                            Target AppId / Package ID(s): <strong id="slm-direct-id-label" style="color: #66c0f4;"></strong>
                        </span>
                        <button id="slm-direct-remove-btn" class="slm-btn slm-btn-danger slm-btn-sm">
                            Remove ID(s) Directly
                        </button>
                    </div>

                    <div class="slm-table-container">
                        <table class="slm-table">
                            <thead>
                                <tr>
                                    <th style="width: 32px; text-align: center;">
                                        <input type="checkbox" id="slm-select-all" title="Select all matching licenses" />
                                    </th>
                                    <th style="width: 110px;">AppId / PkgID</th>
                                    <th>License Name</th>
                                    <th style="width: 120px;">Date</th>
                                    <th style="width: 85px; text-align: right;">Action</th>
                                </tr>
                            </thead>
                            <tbody id="slm-table-body">
                                <tr>
                                    <td colspan="5" class="slm-empty">Initializing...</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <div id="slm-log-output" class="slm-log-box"></div>
                </div>

                <div class="slm-footer">
                    <div id="slm-status-text" class="slm-status">Ready.</div>
                    <div class="slm-footer-actions">
                        <button id="slm-stop-btn" class="slm-btn" style="display: none;">Stop</button>
                        <button id="slm-remove-selected-btn" class="slm-btn slm-btn-danger" disabled>
                            Remove Selected (0)
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        bindEvents(overlay);
        renderLicenseList();
    }

    /**
     * Wire up UI event listeners
     */
    function bindEvents(overlay) {
        const searchInput = document.getElementById("slm-search-input");
        const clearSearchBtn = document.getElementById("slm-clear-search-btn");
        const scanBtn = document.getElementById("slm-scan-btn");
        const stopBtn = document.getElementById("slm-stop-btn");
        const removeSelectedBtn = document.getElementById("slm-remove-selected-btn");
        const directRemoveBtn = document.getElementById("slm-direct-remove-btn");
        const selectAllCheckbox = document.getElementById("slm-select-all");
        const tbody = document.getElementById("slm-table-body");
        const minimizeBtn = document.getElementById("slm-minimize-btn");
        const closeBtn = document.getElementById("slm-close-btn");
        const filterBtns = overlay.querySelectorAll(".slm-filter-btn");

        searchInput.addEventListener("input", (e) => {
            state.searchQuery = e.target.value;
            renderLicenseList();
        });

        clearSearchBtn.addEventListener("click", () => {
            state.searchQuery = "";
            searchInput.value = "";
            renderLicenseList();
            searchInput.focus();
        });

        filterBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                filterBtns.forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                state.filterMode = btn.getAttribute("data-filter") || "all";
                renderLicenseList();
            });
        });

        scanBtn.addEventListener("click", () => {
            populate(() => renderLicenseList());
        });

        stopBtn.addEventListener("click", () => {
            state.abortRequested = true;
            logMessage("Stopping current operation...", "warn");
        });

        selectAllCheckbox.addEventListener("change", (e) => {
            const filtered = getFilteredLicenses();
            if (e.target.checked) {
                filtered.forEach((item) => state.selectedIds.add(item.id));
            } else {
                filtered.forEach((item) => state.selectedIds.delete(item.id));
            }
            renderLicenseList();
        });

        tbody.addEventListener("click", async (e) => {
            const removeBtn = e.target.closest(".slm-single-remove-btn");
            if (removeBtn) {
                const id = removeBtn.getAttribute("data-id");
                if (id && !state.isRemoving && !state.isScanning) {
                    await removePackages([id]);
                }
                return;
            }

            const checkbox = e.target.closest(".slm-row-checkbox");
            if (checkbox) {
                const id = checkbox.getAttribute("data-id");
                if (checkbox.checked) {
                    state.selectedIds.add(id);
                } else {
                    state.selectedIds.delete(id);
                }
                renderLicenseList();
            }
        });

        removeSelectedBtn.addEventListener("click", async () => {
            const idsToRemove = Array.from(state.selectedIds);
            if (idsToRemove.length === 0) return;
            await removePackages(idsToRemove);
        });

        directRemoveBtn.addEventListener("click", async () => {
            const rawQuery = state.searchQuery.trim();
            const directIds = rawQuery
                .split(/[\s,]+/)
                .map((t) => t.trim())
                .filter((t) => /^\d+$/.test(t));

            if (directIds.length === 0) return;
            await removePackages(directIds);
        });

        minimizeBtn.addEventListener("click", () => {
            overlay.classList.toggle("slm-minimized");
        });

        closeBtn.addEventListener("click", () => {
            state.abortRequested = true;
            overlay.remove();
        });
    }

    // Expose programmatic API on window for console use as well
    window.SteamLicenseManager = {
        open: createUI,
        populate,
        removePackages,
        search(query) {
            state.searchQuery = String(query || "");
            const searchInput = document.getElementById("slm-search-input");
            if (searchInput) {
                searchInput.value = state.searchQuery;
            }
            renderLicenseList();
            return getFilteredLicenses();
        },
        getState: () => state,
    };

    // Initialize UI and start scanning automatically
    (async function main() {
        createUI();
        await populate(() => renderLicenseList());
    })();
})();

