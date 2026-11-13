// ==UserScript==
// @name         Steam License Manager
// @namespace    https://store.steampowered.com/
// @version      1.0.0
// @description  Scan, search, sort, export, and permanently remove Steam complimentary licenses, plus activate Steam keys in bulk.
// @match        https://store.steampowered.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/**
 * Steam License Manager
 * Based on steam-demo-cleaner.js & steam-activate-key.js
 *
 * Run this script in the browser console while logged into https://store.steampowered.com
 * or install it as a Tampermonkey/Violentmonkey userscript.
 * It injects an interactive UI panel allowing you to scan your account licenses,
 * search/sort/export licenses, remove specific Steam AppIds / Package IDs, and activate keys.
 */

(function () {
    "use strict";

    const MODAL_ID = "steam-license-manager-overlay";
    const LAUNCHER_ID = "steam-license-manager-launcher";
    const STYLE_ID = "steam-license-manager-styles";
    const DEMO_REGEX = /\b(?:trailer|teaser|demo|pegi|esrb)\b/i;
    const REGISTER_KEY_BASE_URL = "https://store.steampowered.com/account/registerkey?key=";
    const AJAX_REGISTER_KEY_URL = "https://store.steampowered.com/account/ajaxregisterkey/";
    const STEAM_KEY_REGEX = /^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/;
    const RATE_LIMIT_WAIT_MS = 600000; // 10 minutes

    // State
    const state = {
        licenses: [], // Array of { index, id, name, date, dateMs, acquisition, isDemo, removed }
        selectedIds: new Set(),
        pendingRemoveIds: [],
        searchQuery: "",
        filterMode: "all", // "all" | "demo" | "selected"
        sortField: "index", // "index" | "id" | "name" | "date"
        sortDir: "asc", // "asc" | "desc"
        isScanning: false,
        isRemoving: false,
        isActivatingKeys: false,
        abortRequested: false,
        cancelWait: null,
    };

    /**
     * Signal abort and immediately cancel any active wait timer
     */
    function requestAbort() {
        state.abortRequested = true;
        if (typeof state.cancelWait === "function") {
            state.cancelWait();
        }
    }

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
                            const parsedDate = Date.parse(date);

                            const item = {
                                index: count,
                                id: packageId,
                                name: name || `License #${packageId}`,
                                date,
                                dateMs: Number.isNaN(parsedDate) ? 0 : parsedDate,
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

        for (let i = 0; i < appIds.length;) {
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
                    await waitWithCancel(RATE_LIMIT_WAIT_MS, (remainingMs) => {
                        const statusText = document.getElementById("slm-status-text");
                        if (statusText) {
                            statusText.textContent = `Rate limited on ${label}. Retrying in ${formatDuration(remainingMs)}...`;
                        }
                    });
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
     * Format milliseconds into MM:SS for live countdowns
     */
    function formatDuration(ms) {
        const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    /**
     * Wait for the exact duration (ms) using a single master timer while allowing immediate cancellation
     * and optional wall-clock countdown updates
     */
    function waitWithCancel(ms, onCountdownTick) {
        if (state.abortRequested || ms <= 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const endTime = Date.now() + ms;
            let intervalId = null;

            if (typeof onCountdownTick === "function") {
                onCountdownTick(ms);
                intervalId = setInterval(() => {
                    const remaining = Math.max(0, endTime - Date.now());
                    onCountdownTick(remaining);
                }, 1000);
            }

            const cleanup = () => {
                if (intervalId !== null) {
                    clearInterval(intervalId);
                    intervalId = null;
                }
                state.cancelWait = null;
            };

            const timerId = setTimeout(() => {
                cleanup();
                resolve();
            }, ms);

            state.cancelWait = () => {
                clearTimeout(timerId);
                cleanup();
                resolve();
            };
        });
    }

    /**
     * Toggle column sorting ("id" | "name" | "date")
     */
    function toggleSort(field) {
        if (state.sortField === field) {
            if (state.sortDir === "asc") {
                state.sortDir = "desc";
            } else {
                state.sortField = "index";
                state.sortDir = "asc";
            }
        } else {
            state.sortField = field;
            state.sortDir = "asc";
        }
        renderLicenseList();
    }

    /**
     * Filter and sort licenses based on the search query, active filter mode, and sort column
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

        const filtered = state.licenses.filter((item) => {
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

        if (state.sortField === "index") {
            return filtered;
        }

        const dir = state.sortDir === "desc" ? -1 : 1;
        return [...filtered].sort((a, b) => {
            if (state.sortField === "id") {
                return (Number(a.id) - Number(b.id)) * dir;
            }
            if (state.sortField === "name") {
                return (
                    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) * dir
                );
            }
            if (state.sortField === "date") {
                if (a.dateMs && b.dateMs && a.dateMs !== b.dateMs) {
                    return (a.dateMs - b.dateMs) * dir;
                }
                // Fallback to chronological scan order (lower index = newer on Steam)
                return (b.index - a.index) * dir;
            }
            return (a.index - b.index) * dir;
        });
    }

    /**
     * Resolve which licenses to export based on scope ("auto" | "selected" | "filtered" | "all")
     */
    function getLicensesToExport(scope = "auto") {
        const activeLicenses = state.licenses.filter((item) => !item.removed);
        if (scope === "all") {
            return activeLicenses;
        }
        if (scope === "selected") {
            return activeLicenses.filter((item) => state.selectedIds.has(item.id));
        }
        if (scope === "filtered") {
            return getFilteredLicenses();
        }
        // "auto": export selected licenses if any are checked, otherwise export currently filtered list
        if (state.selectedIds.size > 0) {
            return activeLicenses.filter((item) => state.selectedIds.has(item.id));
        }
        return getFilteredLicenses();
    }

    /**
     * Escape a value for CSV output (RFC 4180)
     */
    function escapeCsvField(value) {
        const str = String(value ?? "");
        if (/[",\r\n]/.test(str)) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }

    /**
     * Export licenses as a downloadable .txt or .csv file
     */
    function exportLicenses(format = "txt", scope = "auto") {
        const fmt = String(format).toLowerCase() === "csv" ? "csv" : "txt";
        const items = getLicensesToExport(scope);

        if (!items || items.length === 0) {
            logMessage("No licenses available to export.", "warn");
            return false;
        }

        let content = "";
        let mimeType = "text/plain;charset=utf-8";

        if (fmt === "csv") {
            mimeType = "text/csv;charset=utf-8";
            const header = ["AppId/PackageId", "Name", "Date", "Acquisition", "IsDemo"];
            const rows = items.map((item) =>
                [
                    escapeCsvField(item.id),
                    escapeCsvField(item.name),
                    escapeCsvField(item.date || ""),
                    escapeCsvField(item.acquisition || ""),
                    escapeCsvField(item.isDemo ? "true" : "false"),
                ].join(",")
            );
            // Prefix with UTF-8 BOM so spreadsheet software opens Unicode characters cleanly
            content = "\uFEFF" + [header.join(","), ...rows].join("\r\n");
        } else {
            const lines = items.map((item) => {
                const meta = [item.date, item.acquisition].filter(Boolean).join(" | ");
                return meta ? `${item.id} - ${item.name} (${meta})` : `${item.id} - ${item.name}`;
            });
            content = lines.join("\r\n");
        }

        const dateStamp = new Date().toISOString().slice(0, 10);
        const filename = `steam-licenses-${dateStamp}.${fmt}`;

        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);

        const scopeDesc =
            scope === "auto"
                ? state.selectedIds.size > 0
                    ? "selected"
                    : "filtered"
                : scope;
        logMessage(`Exported ${items.length} ${scopeDesc} license(s) to ${filename}.`, "success");
        return true;
    }

    /**
     * Validate Steam keys line-by-line (format: AAAAA-BBBBB-CCCCC, letters or numbers)
     * Converts each line to string and uppercases it.
     */
    function validateSteamKeys(rawInput) {
        const lines = Array.isArray(rawInput)
            ? rawInput
            : String(rawInput ?? "").split(/\r?\n/);

        const validKeys = [];
        const invalidLines = [];

        lines.forEach((rawLine, idx) => {
            const cleaned = rawLine !== undefined && rawLine !== null ? rawLine.toString().trim().toUpperCase() : "";
            if (!cleaned) return; // Skip empty lines

            if (STEAM_KEY_REGEX.test(cleaned)) {
                validKeys.push(cleaned);
            } else {
                invalidLines.push({
                    lineNumber: idx + 1,
                    value: cleaned,
                });
            }
        });

        return {
            valid: validKeys.length > 0 && invalidLines.length === 0,
            validKeys,
            invalidLines,
        };
    }

    /**
     * Validate and open a new Steam key registration tab for each valid key line
     */
    function activateKeys(rawInput) {
        const { valid, validKeys, invalidLines } = validateSteamKeys(rawInput);

        if (invalidLines.length > 0) {
            const details = invalidLines
                .map((item) => `Line ${item.lineNumber}: "${item.value}"`)
                .join("; ");
            logMessage(
                `Invalid Steam key format (expected AAAAA-BBBBB-CCCCC) on ${details}`,
                "error"
            );
            return { valid: false, validKeys, invalidLines, openedKeys: [], blockedKeys: [] };
        }

        if (validKeys.length === 0) {
            logMessage("Please enter at least one valid Steam key (AAAAA-BBBBB-CCCCC).", "warn");
            return { valid: false, validKeys, invalidLines, openedKeys: [], blockedKeys: [] };
        }

        const openedKeys = [];
        const blockedKeys = [];

        validKeys.forEach((key) => {
            const formattedKey = key.toString().toUpperCase();
            const url = `${REGISTER_KEY_BASE_URL}${formattedKey}`;
            const win = window.open(url, "_blank");

            if (win) {
                openedKeys.push(formattedKey);
                logMessage(`Opened activation tab for key: ${formattedKey}`, "success");
            } else {
                blockedKeys.push(formattedKey);
            }
        });

        if (blockedKeys.length > 0) {
            logMessage(
                `Opened ${openedKeys.length}/${validKeys.length} tab(s). Browser pop-up blocker prevented opening the remaining ${blockedKeys.length} tab(s). Allow pop-ups for store.steampowered.com in your address bar to open all tabs at once.`,
                "warn"
            );
        }

        return { valid: true, validKeys, invalidLines: [], openedKeys, blockedKeys };
    }

    /**
     * Map Steam's purchase_result_details code to a human-readable message
     */
    function getKeyActivationErrorMessage(detailCode) {
        const messages = {
            1: "Invalid product key",
            9: "Account already owns this product",
            13: "Product not available in your region",
            14: "Invalid product key (not found)",
            15: "Product key already activated by another account",
            24: "Requires ownership of the base game first",
            36: "Requires PS3/console account link first",
            50: "Code is a Steam Wallet code (redeem on Wallet page instead)",
            53: "Too many activation attempts (rate-limited by Steam)",
        };
        return messages[detailCode] || `Activation failed (code ${detailCode ?? "unknown"})`;
    }

    /**
     * Activate Steam keys directly in the background via Steam's AJAX endpoint (no new tabs required)
     */
    async function activateKeysAjax(rawInput) {
        const { valid, validKeys, invalidLines } = validateSteamKeys(rawInput);

        if (invalidLines.length > 0) {
            const details = invalidLines
                .map((item) => `Line ${item.lineNumber}: "${item.value}"`)
                .join("; ");
            logMessage(`Invalid Steam key format (expected AAAAA-BBBBB-CCCCC) on ${details}`, "error");
            return { valid: false, activatedKeys: [], failedKeys: [] };
        }

        if (!valid || validKeys.length === 0) {
            logMessage("Please enter at least one valid Steam key (AAAAA-BBBBB-CCCCC).", "warn");
            return { valid: false, activatedKeys: [], failedKeys: [] };
        }

        if (!checkSession()) {
            logMessage("No active Steam session detected. Please log in to your Steam account.", "error");
            return { valid: false, activatedKeys: [], failedKeys: [] };
        }

        state.isActivatingKeys = true;
        state.abortRequested = false;
        updateControlsState();

        const activatedKeys = [];
        const failedKeys = [];

        for (let i = 0; i < validKeys.length; i++) {
            if (state.abortRequested) {
                logMessage(`Key activation stopped by user (${activatedKeys.length}/${validKeys.length} activated).`, "warn");
                break;
            }

            const formattedKey = validKeys[i].toString().toUpperCase();
            logMessage(`Activating key ${formattedKey} (${i + 1}/${validKeys.length})...`);

            try {
                const response = await fetch(AJAX_REGISTER_KEY_URL, {
                    method: "POST",
                    headers: {
                        accept: "*/*",
                        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    },
                    body: `product_key=${encodeURIComponent(formattedKey)}&sessionid=${encodeURIComponent(window.g_sessionID)}`,
                    mode: "cors",
                    credentials: "include",
                });

                if (
                    (response.redirected &&
                        (response.url.includes("/login") || response.url.includes("login.steampowered.com"))) ||
                    response.status === 401 ||
                    response.status === 403
                ) {
                    logMessage("Steam session has expired. Please log in again.", "error");
                    break;
                }

                const data = await response.json();
                const lineItems = data?.purchase_receipt_info?.line_items || [];
                const itemNames = lineItems
                    .map((li) => li.line_item_description)
                    .filter(Boolean)
                    .join(", ");

                if (data.success === 1) {
                    activatedKeys.push({ key: formattedKey, product: itemNames });
                    logMessage(
                        `Activated ${formattedKey}${itemNames ? ` — ${itemNames}` : ""} (${i + 1}/${validKeys.length})`,
                        "success"
                    );
                } else {
                    const detailCode = data.purchase_result_details;
                    const reason = getKeyActivationErrorMessage(detailCode);
                    failedKeys.push({ key: formattedKey, code: detailCode, reason });
                    logMessage(
                        `Key ${formattedKey}: ${reason}${itemNames ? ` (${itemNames})` : ""}`,
                        detailCode === 9 ? "warn" : "error"
                    );

                    // Stop early if Steam rate-limited key activations (code 53)
                    if (detailCode === 53) {
                        logMessage(
                            "Stopped remaining key activations because Steam rate-limited key redemption (code 53). Try again in ~30-60 minutes.",
                            "warn"
                        );
                        break;
                    }
                }
            } catch (err) {
                failedKeys.push({ key: formattedKey, reason: err.message || String(err) });
                logMessage(`Error activating ${formattedKey}: ${err.message || err}`, "error");
            }

            if (i + 1 < validKeys.length && !state.abortRequested) {
                await waitWithCancel(1500);
            }
        }

        state.isActivatingKeys = false;
        updateControlsState();
        logMessage(
            `Key activation finished: ${activatedKeys.length} succeeded, ${failedKeys.length} failed/skipped.`,
            activatedKeys.length > 0 ? "success" : "warn"
        );
        return { valid: true, activatedKeys, failedKeys };
    }

    /**
     * Render clickable fallback links when the browser popup blocker blocks multi-tab opening
     */
    function renderBlockedKeyLinks(blockedKeys) {
        const errorBox = document.getElementById("slm-key-error");
        const textarea = document.getElementById("slm-key-textarea");
        const submitBtn = document.getElementById("slm-key-submit-btn");
        if (!errorBox) return;

        if (!blockedKeys || blockedKeys.length === 0) {
            errorBox.style.display = "none";
            errorBox.innerHTML = "";
            if (submitBtn) {
                submitBtn.textContent = "Open in New Tabs";
            }
            return;
        }

        if (textarea) {
            textarea.value = blockedKeys.join("\n");
        }
        if (submitBtn) {
            submitBtn.textContent = `Open Remaining Tabs (${blockedKeys.length})`;
        }

        const linksHtml = blockedKeys
            .map((key) => {
                const url = `${REGISTER_KEY_BASE_URL}${encodeURIComponent(key)}`;
                return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="slm-blocked-key-link" data-key="${escapeHtml(
                    key
                )}">Open ${escapeHtml(key)} ↗</a>`;
            })
            .join(" ");

        errorBox.innerHTML = `
            <div style="margin-bottom: 6px;">
                <strong>Browser pop-up blocker blocked ${blockedKeys.length} tab(s).</strong><br/>
                To open all keys in one click, allow pop-ups for <strong>store.steampowered.com</strong> in your address bar, click
                <strong>Activate Directly (No Tabs)</strong>, or click each key below:
            </div>
            <div class="slm-blocked-links-wrap">${linksHtml}</div>
        `;
        errorBox.style.display = "block";
    }

    /**
     * Open the Activate Key(s) popup inside the manager UI
     */
    function openActivateKeysPopup() {
        const popup = document.getElementById("slm-key-popup-backdrop");
        const textarea = document.getElementById("slm-key-textarea");
        const errorBox = document.getElementById("slm-key-error");
        const submitBtn = document.getElementById("slm-key-submit-btn");
        if (!popup) return;

        if (errorBox) {
            errorBox.style.display = "none";
            errorBox.innerHTML = "";
        }
        if (submitBtn) {
            submitBtn.textContent = "Open in New Tabs";
        }
        popup.style.display = "flex";
        if (textarea) {
            textarea.focus();
        }
    }

    /**
     * Close the Activate Key(s) popup
     */
    function closeActivateKeysPopup() {
        const popup = document.getElementById("slm-key-popup-backdrop");
        const errorBox = document.getElementById("slm-key-error");
        const submitBtn = document.getElementById("slm-key-submit-btn");
        if (popup) {
            popup.style.display = "none";
        }
        if (errorBox) {
            errorBox.style.display = "none";
            errorBox.innerHTML = "";
        }
        if (submitBtn) {
            submitBtn.textContent = "Open in New Tabs";
        }
    }

    /**
     * Open the confirmation dialog before removing any license(s)
     */
    function openConfirmRemovePopup(ids) {
        const normalizedIds = (Array.isArray(ids) ? ids : [ids])
            .map((id) => String(id ?? "").trim())
            .filter(Boolean);
        if (normalizedIds.length === 0) return;

        state.pendingRemoveIds = normalizedIds;

        const popup = document.getElementById("slm-confirm-remove-backdrop");
        const countEl = document.getElementById("slm-confirm-remove-count");
        const previewEl = document.getElementById("slm-confirm-remove-preview");
        if (!popup) return;

        if (countEl) {
            countEl.textContent = String(normalizedIds.length);
        }

        if (previewEl) {
            const previewItems = normalizedIds.slice(0, 5).map((id) => {
                const found = state.licenses.find((l) => l.id === id);
                return found ? `${id} — ${found.name}` : `ID #${id}`;
            });
            if (normalizedIds.length > 5) {
                previewItems.push(`...and ${normalizedIds.length - 5} more`);
            }
            previewEl.textContent = previewItems.join("\n");
            previewEl.style.display = "block";
        }

        popup.style.display = "flex";
    }

    /**
     * Close the confirmation dialog for removing licenses
     */
    function closeConfirmRemovePopup() {
        state.pendingRemoveIds = [];
        const popup = document.getElementById("slm-confirm-remove-backdrop");
        if (popup) {
            popup.style.display = "none";
        }
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
                position: relative;
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
            .slm-sortable-th {
                cursor: pointer;
                user-select: none;
                transition: color 0.15s, background 0.15s;
            }
            .slm-sortable-th:hover {
                color: #ffffff;
                background: #1f2833;
            }
            .slm-sortable-th.slm-sorted {
                color: #66c0f4;
            }
            .slm-sort-arrow {
                display: inline-block;
                margin-left: 4px;
                font-size: 10px;
                opacity: 0.75;
            }
            .slm-confirm-preview {
                background: #101822;
                border: 1px solid #2a475e;
                border-radius: 3px;
                padding: 7px 10px;
                font-family: Consolas, monospace;
                font-size: 11px;
                color: #c7d5e0;
                white-space: pre-wrap;
                max-height: 95px;
                overflow-y: auto;
            }
            #${LAUNCHER_ID} {
                position: fixed;
                right: 20px;
                bottom: 20px;
                z-index: 999990;
                background: linear-gradient(90deg, #47bfff 0%, #1a44c2 100%);
                border: 1px solid #66c0f4;
                color: #ffffff;
                padding: 9px 15px;
                border-radius: 4px;
                font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.65);
                transition: transform 0.15s, box-shadow 0.15s;
            }
            #${LAUNCHER_ID}:hover {
                transform: translateY(-1px);
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.8);
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
            .slm-btn-success {
                background: linear-gradient(90deg, #6fa720 0%, #588a1b 100%);
                border-color: #8ed629;
            }
            .slm-btn-success:hover:not(:disabled) {
                background: linear-gradient(90deg, #7ec025 0%, #659e20 100%);
            }
            .slm-popup-backdrop {
                position: absolute;
                inset: 0;
                background: rgba(0, 0, 0, 0.78);
                display: none;
                align-items: center;
                justify-content: center;
                z-index: 10;
                padding: 16px;
            }
            .slm-popup {
                width: min(480px, 92vw);
                background: linear-gradient(180deg, #1b2838 0%, #171a21 100%);
                border: 1px solid #47bfff;
                border-radius: 6px;
                box-shadow: 0 12px 36px rgba(0, 0, 0, 0.9);
                padding: 16px 18px;
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .slm-popup-title {
                margin: 0;
                font-size: 15px;
                font-weight: 600;
                color: #ffffff;
            }
            .slm-popup-desc {
                margin: 0;
                font-size: 12px;
                color: #9fb2c4;
                line-height: 1.45;
            }
            .slm-popup-warn {
                background: rgba(229, 181, 79, 0.14);
                border: 1px solid #e5b54f;
                border-radius: 3px;
                padding: 8px 10px;
                color: #f3d078;
                font-size: 12px;
                line-height: 1.45;
            }
            .slm-textarea {
                width: 100%;
                box-sizing: border-box;
                background: #101822;
                border: 1px solid #2a475e;
                border-radius: 3px;
                padding: 9px 11px;
                color: #ffffff;
                font-family: Consolas, monospace;
                font-size: 13px;
                line-height: 1.5;
                resize: vertical;
                min-height: 120px;
                outline: none;
                text-transform: uppercase;
            }
            .slm-textarea:focus {
                border-color: #66c0f4;
                box-shadow: 0 0 0 1px rgba(102, 192, 244, 0.3);
            }
            .slm-popup-error {
                display: none;
                background: rgba(139, 38, 38, 0.35);
                border: 1px solid #b83b3b;
                border-radius: 3px;
                padding: 8px 10px;
                color: #ff8585;
                font-size: 12px;
                line-height: 1.4;
                max-height: 140px;
                overflow-y: auto;
            }
            .slm-blocked-links-wrap {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-top: 6px;
            }
            .slm-blocked-key-link {
                display: inline-block;
                background: #2a475e;
                border: 1px solid #47bfff;
                color: #ffffff !important;
                text-decoration: none !important;
                padding: 4px 8px;
                border-radius: 3px;
                font-family: Consolas, monospace;
                font-size: 11px;
                transition: background 0.15s;
            }
            .slm-blocked-key-link:hover {
                background: #3d6c91;
            }
            .slm-popup-actions {
                display: flex;
                justify-content: flex-end;
                gap: 8px;
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
     * Render the filtered & sorted license rows in the table
     */
    function renderLicenseList() {
        const tbody = document.getElementById("slm-table-body");
        const countBadge = document.getElementById("slm-count-badge");
        const selectAllCheckbox = document.getElementById("slm-select-all");
        const removeSelectedBtn = document.getElementById("slm-remove-selected-btn");
        const exportTxtBtn = document.getElementById("slm-export-txt-btn");
        const exportCsvBtn = document.getElementById("slm-export-csv-btn");
        const directBar = document.getElementById("slm-direct-remove-bar");
        const directIdLabel = document.getElementById("slm-direct-id-label");

        if (!tbody) return;

        // Update sort header indicators
        const sortHeaders = document.querySelectorAll(".slm-sortable-th");
        sortHeaders.forEach((th) => {
            const field = th.getAttribute("data-sort");
            const arrowEl = th.querySelector(".slm-sort-arrow");
            if (state.sortField === field) {
                th.classList.add("slm-sorted");
                if (arrowEl) {
                    arrowEl.textContent = state.sortDir === "asc" ? "▲" : "▼";
                }
            } else {
                th.classList.remove("slm-sorted");
                if (arrowEl) {
                    arrowEl.textContent = "⇅";
                }
            }
        });

        const activeLicenses = state.licenses.filter((l) => !l.removed);
        const filtered = getFilteredLicenses();
        const busy = state.isScanning || state.isRemoving || state.isActivatingKeys;
        const exportableCount = state.selectedIds.size > 0 ? state.selectedIds.size : filtered.length;
        const exportHint =
            state.selectedIds.size > 0
                ? `Export ${state.selectedIds.size} selected license(s)`
                : `Export ${filtered.length} filtered license(s)`;

        if (countBadge) {
            countBadge.textContent = `${filtered.length} / ${activeLicenses.length} Licenses (${state.selectedIds.size} selected)`;
        }

        if (removeSelectedBtn) {
            removeSelectedBtn.textContent = `Remove Selected (${state.selectedIds.size})`;
            removeSelectedBtn.disabled = state.selectedIds.size === 0 || busy;
        }

        if (exportTxtBtn) {
            exportTxtBtn.disabled = exportableCount === 0 || state.isScanning;
            exportTxtBtn.title = `${exportHint} as .txt`;
        }

        if (exportCsvBtn) {
            exportCsvBtn.disabled = exportableCount === 0 || state.isScanning;
            exportCsvBtn.title = `${exportHint} as .csv`;
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
                const disabledAttr = busy ? "disabled" : "";
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
     * Enable / disable buttons according to scanning / removing / key activation state
     */
    function updateControlsState() {
        const scanBtn = document.getElementById("slm-scan-btn");
        const stopBtn = document.getElementById("slm-stop-btn");
        const removeSelectedBtn = document.getElementById("slm-remove-selected-btn");
        const directRemoveBtn = document.getElementById("slm-direct-remove-btn");
        const exportTxtBtn = document.getElementById("slm-export-txt-btn");
        const exportCsvBtn = document.getElementById("slm-export-csv-btn");
        const keyAjaxBtn = document.getElementById("slm-key-ajax-btn");
        const keySubmitBtn = document.getElementById("slm-key-submit-btn");

        const busy = state.isScanning || state.isRemoving || state.isActivatingKeys;
        const exportableCount = getLicensesToExport("auto").length;

        if (scanBtn) {
            scanBtn.disabled = busy;
            scanBtn.textContent = state.isScanning
                ? "Scanning..."
                : state.licenses.length > 0
                ? "Rescan Licenses"
                : "Scan Licenses";
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
        if (exportTxtBtn) {
            exportTxtBtn.disabled = state.isScanning || exportableCount === 0;
        }
        if (exportCsvBtn) {
            exportCsvBtn.disabled = state.isScanning || exportableCount === 0;
        }
        if (keyAjaxBtn) {
            keyAjaxBtn.disabled = busy;
            keyAjaxBtn.textContent = state.isActivatingKeys
                ? "Activating..."
                : "Activate Directly (No Tabs)";
        }
        if (keySubmitBtn) {
            keySubmitBtn.disabled = busy;
        }
    }

    /**
     * Inject a floating launcher button when the modal is closed or when installed as a Userscript
     */
    function injectLauncherButton() {
        injectStyles();
        let launcher = document.getElementById(LAUNCHER_ID);
        if (!launcher) {
            launcher = document.createElement("button");
            launcher.id = LAUNCHER_ID;
            launcher.type = "button";
            launcher.textContent = "Steam License Manager";
            launcher.title = "Open Steam License Manager";
            launcher.addEventListener("click", () => {
                createUI();
            });
            document.body.appendChild(launcher);
        }
        const modalOpen = Boolean(document.getElementById(MODAL_ID));
        launcher.style.display = modalOpen ? "none" : "block";
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

                        <button id="slm-activate-keys-btn" class="slm-btn slm-btn-success" title="Activate one or more Steam keys">
                            Activate Key(s)
                        </button>
                        <button id="slm-scan-btn" class="slm-btn slm-btn-primary">Scan Licenses</button>
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
                                    <th style="width: 120px;" class="slm-sortable-th" data-sort="id" title="Click to sort by AppId / Package ID">
                                        AppId / PkgID <span class="slm-sort-arrow">⇅</span>
                                    </th>
                                    <th class="slm-sortable-th" data-sort="name" title="Click to sort by License Name">
                                        License Name <span class="slm-sort-arrow">⇅</span>
                                    </th>
                                    <th style="width: 120px;" class="slm-sortable-th" data-sort="date" title="Click to sort by Date">
                                        Date <span class="slm-sort-arrow">⇅</span>
                                    </th>
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
                        <button id="slm-export-txt-btn" class="slm-btn" disabled title="Export licenses as .txt">
                            Export .TXT
                        </button>
                        <button id="slm-export-csv-btn" class="slm-btn" disabled title="Export licenses as .csv">
                            Export .CSV
                        </button>
                        <button id="slm-stop-btn" class="slm-btn" style="display: none;">Stop</button>
                        <button id="slm-remove-selected-btn" class="slm-btn slm-btn-danger" disabled>
                            Remove Selected (0)
                        </button>
                    </div>
                </div>

                <div id="slm-key-popup-backdrop" class="slm-popup-backdrop" role="dialog" aria-label="Activate Steam Keys">
                    <div class="slm-popup">
                        <h3 class="slm-popup-title">Activate Steam Key(s)</h3>
                        <p class="slm-popup-desc">
                            Enter one Steam key per line (<strong style="color: #66c0f4;">AAAAA-BBBBB-CCCCC</strong>).
                            You can activate keys directly in the background via Steam's API or open each key in a new browser tab.
                        </p>
                        <div class="slm-popup-warn">
                            <strong>⚠ Browser Pop-up Permission (Tab Mode Only):</strong>
                            If using <em>Open in New Tabs</em> for multiple keys, make sure pop-ups are allowed for
                            <strong>store.steampowered.com</strong> in your browser's address bar — or use
                            <strong>Activate Directly (No Tabs)</strong>.
                        </div>
                        <textarea
                            id="slm-key-textarea"
                            class="slm-textarea"
                            placeholder="AAAAA-BBBBB-CCCCC&#10;12345-ABCDE-67890"
                            spellcheck="false"
                        ></textarea>
                        <div id="slm-key-error" class="slm-popup-error"></div>
                        <div class="slm-popup-actions">
                            <button id="slm-key-cancel-btn" class="slm-btn">Cancel</button>
                            <button id="slm-key-ajax-btn" class="slm-btn slm-btn-primary" title="Redeem keys directly via Steam API without opening new tabs">
                                Activate Directly (No Tabs)
                            </button>
                            <button id="slm-key-submit-btn" class="slm-btn slm-btn-success" title="Open each key in a new browser tab">
                                Open in New Tabs
                            </button>
                        </div>
                    </div>
                </div>

                <div id="slm-confirm-remove-backdrop" class="slm-popup-backdrop" role="alertdialog" aria-label="Confirm License Removal">
                    <div class="slm-popup" style="border-color: #b83b3b;">
                        <h3 class="slm-popup-title">Confirm License Removal</h3>
                        <p class="slm-popup-desc">
                            You are about to remove <strong id="slm-confirm-remove-count" style="color: #ffffff;">0</strong> license(s) from your Steam account:
                        </p>
                        <div id="slm-confirm-remove-preview" class="slm-confirm-preview" style="display: none;"></div>
                        <div class="slm-popup-warn" style="background: rgba(139, 38, 38, 0.35); border-color: #b83b3b; color: #ff8585;">
                            <strong>⚠ Warning:</strong> Any removal of licenses from your Steam account is <strong>permanent and irreversible</strong>.
                        </div>
                        <div class="slm-popup-actions">
                            <button id="slm-confirm-remove-cancel-btn" class="slm-btn">Cancel</button>
                            <button id="slm-confirm-remove-submit-btn" class="slm-btn slm-btn-danger">Remove Permanently</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        injectLauncherButton();
        bindEvents(overlay);
        updateControlsState();
        renderLicenseList();
    }

    /**
     * Wire up UI event listeners
     */
    function bindEvents(overlay) {
        const searchInput = document.getElementById("slm-search-input");
        const clearSearchBtn = document.getElementById("slm-clear-search-btn");
        const activateKeysBtn = document.getElementById("slm-activate-keys-btn");
        const keyPopupBackdrop = document.getElementById("slm-key-popup-backdrop");
        const keyTextarea = document.getElementById("slm-key-textarea");
        const keyErrorBox = document.getElementById("slm-key-error");
        const keyCancelBtn = document.getElementById("slm-key-cancel-btn");
        const keyAjaxBtn = document.getElementById("slm-key-ajax-btn");
        const keySubmitBtn = document.getElementById("slm-key-submit-btn");
        const scanBtn = document.getElementById("slm-scan-btn");
        const stopBtn = document.getElementById("slm-stop-btn");
        const removeSelectedBtn = document.getElementById("slm-remove-selected-btn");
        const confirmRemoveBackdrop = document.getElementById("slm-confirm-remove-backdrop");
        const confirmRemoveCancelBtn = document.getElementById("slm-confirm-remove-cancel-btn");
        const confirmRemoveSubmitBtn = document.getElementById("slm-confirm-remove-submit-btn");
        const exportTxtBtn = document.getElementById("slm-export-txt-btn");
        const exportCsvBtn = document.getElementById("slm-export-csv-btn");
        const directRemoveBtn = document.getElementById("slm-direct-remove-btn");
        const selectAllCheckbox = document.getElementById("slm-select-all");
        const tbody = document.getElementById("slm-table-body");
        const minimizeBtn = document.getElementById("slm-minimize-btn");
        const closeBtn = document.getElementById("slm-close-btn");
        const filterBtns = overlay.querySelectorAll(".slm-filter-btn");
        const sortHeaders = overlay.querySelectorAll(".slm-sortable-th");

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

        sortHeaders.forEach((th) => {
            th.addEventListener("click", () => {
                const field = th.getAttribute("data-sort");
                if (field) {
                    toggleSort(field);
                }
            });
        });

        activateKeysBtn.addEventListener("click", () => {
            openActivateKeysPopup();
        });

        keyCancelBtn.addEventListener("click", () => {
            closeActivateKeysPopup();
        });

        keyPopupBackdrop.addEventListener("click", (e) => {
            if (e.target === keyPopupBackdrop) {
                closeActivateKeysPopup();
            }
        });

        keyTextarea.addEventListener("input", () => {
            if (keyErrorBox && keyErrorBox.style.display !== "none") {
                keyErrorBox.style.display = "none";
                keyErrorBox.innerHTML = "";
            }
            if (keySubmitBtn) {
                keySubmitBtn.textContent = "Open in New Tabs";
            }
        });

        keyErrorBox.addEventListener("click", (e) => {
            const link = e.target.closest(".slm-blocked-key-link");
            if (!link) return;
            const clickedKey = link.getAttribute("data-key");
            if (!clickedKey) return;

            logMessage(`Opened activation tab for key: ${clickedKey}`, "success");
            const currentLines = (keyTextarea ? keyTextarea.value : "")
                .split(/\r?\n/)
                .map((l) => l.trim().toUpperCase())
                .filter((l) => l && l !== clickedKey);

            if (currentLines.length === 0) {
                if (keyTextarea) {
                    keyTextarea.value = "";
                }
                closeActivateKeysPopup();
            } else {
                renderBlockedKeyLinks(currentLines);
            }
        });

        keyAjaxBtn.addEventListener("click", async () => {
            const rawText = keyTextarea ? keyTextarea.value : "";
            const { valid, validKeys, invalidLines } = validateSteamKeys(rawText);

            if (invalidLines.length > 0) {
                const invalidMsg = invalidLines
                    .map((item) => `Line ${item.lineNumber}: "${item.value}"`)
                    .join(" | ");
                if (keyErrorBox) {
                    keyErrorBox.textContent = `Invalid Steam key(s) — must match AAAAA-BBBBB-CCCCC: ${invalidMsg}`;
                    keyErrorBox.style.display = "block";
                }
                logMessage(`Invalid Steam key input (${invalidMsg})`, "error");
                return;
            }

            if (!valid || validKeys.length === 0) {
                if (keyErrorBox) {
                    keyErrorBox.textContent = "Please enter at least one Steam key (AAAAA-BBBBB-CCCCC).";
                    keyErrorBox.style.display = "block";
                }
                return;
            }

            closeActivateKeysPopup();
            if (keyTextarea) {
                keyTextarea.value = "";
            }
            await activateKeysAjax(validKeys);
        });

        keySubmitBtn.addEventListener("click", () => {
            const rawText = keyTextarea ? keyTextarea.value : "";
            const { valid, validKeys, invalidLines } = validateSteamKeys(rawText);

            if (invalidLines.length > 0) {
                const invalidMsg = invalidLines
                    .map((item) => `Line ${item.lineNumber}: "${item.value}"`)
                    .join(" | ");
                if (keyErrorBox) {
                    keyErrorBox.textContent = `Invalid Steam key(s) — must match AAAAA-BBBBB-CCCCC: ${invalidMsg}`;
                    keyErrorBox.style.display = "block";
                }
                logMessage(`Invalid Steam key input (${invalidMsg})`, "error");
                return;
            }

            if (!valid || validKeys.length === 0) {
                if (keyErrorBox) {
                    keyErrorBox.textContent = "Please enter at least one Steam key (AAAAA-BBBBB-CCCCC).";
                    keyErrorBox.style.display = "block";
                }
                return;
            }

            const { blockedKeys } = activateKeys(validKeys);

            if (blockedKeys && blockedKeys.length > 0) {
                renderBlockedKeyLinks(blockedKeys);
                return;
            }

            if (keyTextarea) {
                keyTextarea.value = "";
            }
            closeActivateKeysPopup();
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
            requestAbort();
            logMessage("Stopping current operation...", "warn");
        });

        exportTxtBtn.addEventListener("click", () => {
            exportLicenses("txt", "auto");
        });

        exportCsvBtn.addEventListener("click", () => {
            exportLicenses("csv", "auto");
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

        tbody.addEventListener("click", (e) => {
            const removeBtn = e.target.closest(".slm-single-remove-btn");
            if (removeBtn) {
                const id = removeBtn.getAttribute("data-id");
                if (id && !state.isRemoving && !state.isScanning && !state.isActivatingKeys) {
                    openConfirmRemovePopup([id]);
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

        removeSelectedBtn.addEventListener("click", () => {
            const idsToRemove = Array.from(state.selectedIds);
            if (idsToRemove.length === 0) return;
            openConfirmRemovePopup(idsToRemove);
        });

        confirmRemoveCancelBtn.addEventListener("click", () => {
            closeConfirmRemovePopup();
        });

        confirmRemoveBackdrop.addEventListener("click", (e) => {
            if (e.target === confirmRemoveBackdrop) {
                closeConfirmRemovePopup();
            }
        });

        confirmRemoveSubmitBtn.addEventListener("click", async () => {
            const idsToRemove = [...state.pendingRemoveIds];
            closeConfirmRemovePopup();
            if (idsToRemove.length === 0) return;
            await removePackages(idsToRemove);
        });

        directRemoveBtn.addEventListener("click", () => {
            const rawQuery = state.searchQuery.trim();
            const directIds = rawQuery
                .split(/[\s,]+/)
                .map((t) => t.trim())
                .filter((t) => /^\d+$/.test(t));

            if (directIds.length === 0) return;
            openConfirmRemovePopup(directIds);
        });

        minimizeBtn.addEventListener("click", () => {
            overlay.classList.toggle("slm-minimized");
        });

        closeBtn.addEventListener("click", () => {
            requestAbort();
            overlay.remove();
            injectLauncherButton();
        });
    }

    // Expose programmatic API on window for console use as well
    window.SteamLicenseManager = {
        open: createUI,
        populate,
        removePackages,
        activateKeys,
        activateKeysAjax,
        openActivateKeysPopup,
        openConfirmRemovePopup,
        toggleSort,
        exportLicenses,
        exportTxt: (scope = "auto") => exportLicenses("txt", scope),
        exportCsv: (scope = "auto") => exportLicenses("csv", scope),
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

    // Initialize UI (or launcher button on non-license store pages when installed as a Userscript)
    (function main() {
        const isUserscript = typeof GM_info !== "undefined";
        const isLicensesPage =
            typeof window !== "undefined" &&
            window.location &&
            window.location.pathname.startsWith("/account/licenses");

        if (isUserscript && !isLicensesPage) {
            injectLauncherButton();
        } else {
            createUI();
        }
    })();
})();
