import itemDetailMap from "./combatsimulator/data/itemDetailMap.json";

const STORAGE_KEY = "mwi_simulation_result_archive_v1";
const LEGACY_ARCHIVE_KEY = "mwi_sim_saved_runs_v1";
const LEGACY_COMPARE_KEY = "combat_simulator_comparator_v1.0";
const LEGACY_MIGRATION_KEY = "mwi_simulation_result_legacy_migrated_v1";
const MAX_RECORDS = 200;
const ONE_HOUR = 60 * 60 * 1e9;

let latestResultContext = null;
let records = [];
let storageError = null;

export function classifyDropCategory(hrid, itemMap = itemDetailMap) {
    const item = itemMap[hrid];
    if (hrid?.endsWith("_key_fragment")) return "fragments";
    if (hrid?.endsWith("_charm")) return "charms";
    if (item?.categoryHrid === "/item_categories/resource") return "resources";
    return "other";
}

export function groupArchiveRecords(archiveRecords) {
    const groups = new Map();
    for (const record of archiveRecords) {
        const mapKey = record.mapHrid || record.mapName || "unknown-map";
        const difficulty = String(record.difficulty || record.difficultyTier || "?");
        const key = `${mapKey}|${difficulty}`;
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                mapHrid: record.mapHrid || "",
                mapName: record.mapName || record.mapHrid || "Unknown Map",
                difficulty,
                records: [],
            });
        }
        groups.get(key).records.push(record);
    }

    return [...groups.values()]
        .map((group) => ({
            ...group,
            records: group.records.slice().sort((a, b) => b.savedAt - a.savedAt),
        }))
        .sort((a, b) =>
            a.mapName.localeCompare(b.mapName)
            || a.difficulty.localeCompare(b.difficulty, undefined, { numeric: true })
        );
}

export function normalizeTo24Hours(value, durationHours) {
    const numericValue = Number(value);
    const hours = Number(durationHours);
    if (!Number.isFinite(numericValue) || !Number.isFinite(hours) || hours <= 0) return 0;
    return numericValue * 24 / hours;
}

export function calculateSimulationEph(simResult) {
    const duration = simResult.isDungeon && simResult.lastDungeonFinishTime > 0
        ? simResult.lastDungeonFinishTime
        : simResult.lastEncounterFinishTime > 0
            ? simResult.lastEncounterFinishTime
            : simResult.simulatedTime;
    const encounters = simResult.isDungeon ? simResult.dungeonsCompleted : simResult.encounters;
    return duration > 0 ? encounters * ONE_HOUR / duration : 0;
}

export function minimumPlayerShardDropCount(shardCounts) {
    return shardCounts.length ? Math.min(...shardCounts) : 0;
}

export function roundToTwoDecimals(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Number(numericValue.toFixed(2)) : 0;
}

export function formatTwoDecimalQuantity(value) {
    const numericValue = Number(value);
    return (Number.isFinite(numericValue) ? numericValue : 0).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function sanitizeFileName(value) {
    return String(value || "")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
        .replace(/[. ]+$/g, "")
        .trim() || "simulation-result";
}

export function createRecordExport(record) {
    const groupJson = record.configuration?.groupJson;
    if (!groupJson) return null;

    const groupData = typeof groupJson === "string" ? JSON.parse(groupJson) : groupJson;
    if (!groupData || typeof groupData !== "object") {
        throw new Error("Saved group configuration is not a JSON object.");
    }

    const metric = Number(record.metrics?.eph);
    const metricValue = Number.isFinite(metric)
        ? Number.isInteger(metric) ? String(metric) : metric.toFixed(2)
        : "0";
    const metricTag = sanitizeFileName(metricValue);
    const fileName = [
        sanitizeFileName(record.mapName || "Map"),
        sanitizeFileName(record.difficulty || "Difficulty"),
        metricTag,
    ].join("-") + ".json";
    return {
        fileName,
        content: JSON.stringify(groupData, null, 2),
    };
}

export function formatHourlyQuantity(value) {
    return formatTwoDecimalQuantity(value);
}

export function roundSavedResultValues(record) {
    return {
        ...record,
        metrics: Object.fromEntries(
            Object.entries(record.metrics).map(([key, value]) => [key, roundToTwoDecimals(value)])
        ),
        players: record.players.map((player) => ({
            ...player,
            deathsPerHour: roundToTwoDecimals(player.deathsPerHour),
            deathsPerDay: roundToTwoDecimals(player.deathsPerDay),
            shardsPerDay: roundToTwoDecimals(player.shardsPerDay),
            experience: player.experience.map((item) => ({ ...item, value: roundToTwoDecimals(item.value) })),
            consumables: player.consumables.map((item) => ({
                ...item,
                perHour: roundToTwoDecimals(item.perHour),
                quantity: roundToTwoDecimals(item.quantity),
            })),
        })),
        matchedDrops: record.matchedDrops.map((item) => ({
            ...item,
            quantity: roundToTwoDecimals(item.quantity),
        })),
    };
}

export function comparisonTone(valueA, valueB) {
    if (valueB > valueA) return "text-success";
    if (valueB < valueA) return "text-danger";
    return "";
}

function translate(key, fallback) {
    return globalThis.i18next?.isInitialized && globalThis.i18next.t
        ? globalThis.i18next.t(key, { defaultValue: fallback })
        : fallback;
}

function toolText(key, fallback) {
    return translate(`common:simulationResultTools.${key}`, fallback);
}

function parseNumber(value) {
    const parsed = Number(String(value ?? "").replace(/,/g, "").replace(/[<>]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
}

function itemNameFor(hrid) {
    const item = itemDetailMap[hrid];
    return item
        ? translate(`itemNames.${hrid}`, item.name)
        : hrid || toolText("unknownItem", "Unknown item");
}

function findItemHrid(name) {
    const normalizedName = String(name || "").trim().toLocaleLowerCase();
    if (!normalizedName) return "";
    if (itemDetailMap[normalizedName]) return normalizedName;

    for (const [hrid, item] of Object.entries(itemDetailMap)) {
        if (
            item.name.toLocaleLowerCase() === normalizedName
            || itemNameFor(hrid).toLocaleLowerCase() === normalizedName
        ) {
            return hrid;
        }
    }
    return "";
}

function normalizeDrops(drops, { onlyKnownItems = false, factor = 1 } = {}) {
    if (!Array.isArray(drops)) return [];
    return drops.flatMap((drop) => {
        const name = String(drop?.name || drop?.itemName || "").trim();
        const hrid = drop?.hrid || drop?.itemHrid || findItemHrid(name);
        if (onlyKnownItems && !itemDetailMap[hrid]) return [];
        return [{
            hrid: itemDetailMap[hrid] ? hrid : "",
            name: name || itemNameFor(hrid),
            quantity: parseNumber(drop?.quantity ?? drop?.numericValue ?? drop?.value ?? drop?.rawValue) * factor,
        }];
    });
}

function legacyRecord(id, mapName, difficulty, drops, source, extras = {}) {
    const durationHours = Number(extras.simulationHours);
    const factor = durationHours > 0 ? 24 / durationHours : 1;
    const normalizedDrops = normalizeDrops(drops, {
        onlyKnownItems: source === "compare",
        factor,
    });
    const itemDrops = normalizedDrops.filter((drop) => drop.hrid);
    if (!mapName && itemDrops.length === 0) return null;

    const mapHrid = extras.mapHrid || "";
    const players = Array.isArray(extras.players) ? extras.players : [];
    const deathsPerDay = Number.isFinite(Number(extras.metrics?.deathsPerDay))
        ? Number(extras.metrics.deathsPerDay)
        : parseNumber(extras.metrics?.deathsPerHour) * 24;
    return {
        id,
        schemaVersion: 2,
        savedAt: Number(extras.savedAt) || Date.parse(extras.savedAt) || Date.now(),
        mapHrid,
        mapName: mapName || mapHrid || toolText("unknownMap", "Unknown Map"),
        difficulty: difficulty || "?",
        simulationHours: durationHours || 24,
        mode: extras.mode || "",
        playerNames: players.map((player) => player.name),
        metrics: {
            ...extras.metrics,
            deathsPerDay,
            shardsPerDay: itemDrops
                .filter((drop) => classifyDropCategory(drop.hrid) === "fragments")
                .reduce((total, drop) => total + drop.quantity, 0),
        },
        players,
        configuration: extras.configuration || {},
        experience: extras.experience || [],
        drops: source === "compare" ? itemDrops : normalizedDrops,
        matchedDrops: itemDrops.filter((drop) =>
            ["fragments", "charms"].includes(classifyDropCategory(drop.hrid))
        ),
    };
}

function readLegacyRecords() {
    const migrated = [];
    try {
        const legacyArchive = JSON.parse(localStorage.getItem(LEGACY_ARCHIVE_KEY) || "null");
        if (Array.isArray(legacyArchive?.slots)) {
            legacyArchive.slots.forEach((slot, index) => {
                const record = slot?.record;
                const result = record?.results;
                if (!result) return;
                const config = record.config || {};
                const mapHrid = result.mapHrid
                    || (result.mapType === "dungeon" ? config.dungeonValue : config.zoneValue)
                    || "";
                const mapName = result.mapName || result.map || "";
                const playerSource = Array.isArray(result.consumablesByPlayer)
                    && result.consumablesByPlayer.length
                    ? result.consumablesByPlayer
                    : (config.players || []).filter((player) => player.checked);
                const legacyPlayers = playerSource.map((entry) => {
                        const playerIndex = Number(entry.playerIndex ?? entry.index) || 0;
                        const deathsPerHour = parseNumber(entry.deathPerHour);
                        return {
                            hrid: `player${playerIndex + 1}`,
                            name: entry.playerLabel || entry.label || `Player ${playerIndex + 1}`,
                            deathsPerHour,
                            deathsPerDay: deathsPerHour * 24,
                            experience: [],
                            consumables: normalizeDrops(entry.consumables, { factor: 24 })
                                .map((item) => ({ ...item, perHour: item.quantity / 24 })),
                        };
                    });
                const converted = legacyRecord(
                    `legacy-archive-${slot.id || index}`,
                    mapName,
                    result.difficulty,
                    result.allDrops?.length ? result.allDrops : result.matchedDrops,
                    "archive",
                    {
                        mapHrid,
                        savedAt: record.savedAt || record.createdAt,
                        simulationHours: config.simulationHours,
                        mode: result.mapType || "",
                        players: legacyPlayers,
                        configuration: config,
                        experience: Array.isArray(result.experience)
                            ? result.experience.map((item) => ({
                                name: item.name || "",
                                value: parseNumber(item.numericValue ?? item.value),
                            }))
                            : [],
                        metrics: {
                            eph: parseNumber(result.eph?.numericValue ?? result.eph?.rawValue),
                            deathsPerHour: parseNumber(result.deathPerHour),
                            experiencePerHour: parseNumber(result.experience?.[0]?.numericValue ?? result.experience?.[0]?.value),
                        },
                    }
                );
                if (converted) migrated.push(converted);
            });
        }
    } catch (error) {
        console.error("Could not migrate legacy simulation result archives.", error);
    }

    try {
        const legacyCompare = JSON.parse(localStorage.getItem(LEGACY_COMPARE_KEY) || "null");
        if (Array.isArray(legacyCompare?.dataSlots)) {
            legacyCompare.dataSlots.forEach((slot, index) => {
                const data = slot?.data;
                if (!data) return;
                const converted = legacyRecord(
                    `legacy-compare-${slot.id || index}`,
                    data.map?.name || "",
                    data.map?.difficulty || "?",
                    data.drops,
                    "compare",
                    { simulationHours: 24 }
                );
                if (converted) migrated.push(converted);
            });
        }
    } catch (error) {
        console.error("Could not migrate legacy drop comparison records.", error);
    }
    return migrated;
}

function loadRecords() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw === null ? [] : JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("Saved result archive is not a list.");
        const needsNormalization = parsed.some((record) => record.schemaVersion < 2);
        let loadedRecords = parsed.map((record) => {
            if (record.schemaVersion >= 2) return record;
            const oldDrops = normalizeDrops(record.drops);
            const oldPlayers = Array.isArray(record.players) ? record.players : [];
            return {
                ...record,
                schemaVersion: 2,
                simulationHours: Number(record.simulationHours) || 24,
                playerNames: record.playerNames || (record.playerName ? [record.playerName] : []),
                players: oldPlayers.map((player) => ({
                    ...player,
                    consumables: (player.consumables || []).map((item) => ({
                        ...item,
                        perHour: Number(item.perHour) || Number(item.quantity || 0) / 24,
                    })),
                })),
                drops: oldDrops,
                matchedDrops: oldDrops.filter((drop) =>
                    ["fragments", "charms"].includes(classifyDropCategory(drop.hrid))
                ),
                metrics: {
                    ...record.metrics,
                    deathsPerDay: Number(record.metrics?.deathsPerDay)
                        || normalizeTo24Hours(record.metrics?.deathsPerHour || 0, 1),
                    shardsPerDay: Number(record.metrics?.shardsPerDay)
                        || oldDrops
                            .filter((drop) => classifyDropCategory(drop.hrid) === "fragments")
                            .reduce((total, drop) => total + drop.quantity, 0),
                },
            };
        });

        if (localStorage.getItem(LEGACY_MIGRATION_KEY) !== "done") {
            const existingIds = new Set(loadedRecords.map((record) => record.id));
            for (const migratedRecord of readLegacyRecords()) {
                if (!existingIds.has(migratedRecord.id)) {
                    loadedRecords.push(migratedRecord);
                    existingIds.add(migratedRecord.id);
                }
            }
            loadedRecords.sort((a, b) => b.savedAt - a.savedAt);
            loadedRecords = loadedRecords.slice(0, MAX_RECORDS);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(loadedRecords));
            localStorage.setItem(LEGACY_MIGRATION_KEY, "done");
        } else if (raw === null || needsNormalization) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(loadedRecords));
        }
        return loadedRecords;
    } catch (error) {
        storageError = error;
        console.error("Could not load simulation result archives.", error);
        return [];
    }
}

function persistRecords() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
        storageError = null;
    } catch (error) {
        storageError = error;
        console.error("Could not save simulation result archives.", error);
        throw error;
    }
}

function setNotice(element, message, isError = false) {
    element.textContent = message;
    element.classList.toggle("text-danger", isError);
    element.classList.toggle("text-muted", !isError);
}

function formatQuantity(value) {
    return formatTwoDecimalQuantity(value);
}

function recordTitle(record) {
    const date = new Date(record.savedAt);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function getPlayerNames(record) {
    if (record.players?.length) return record.players.map((player) => player.name);
    if (record.playerNames?.length) return record.playerNames;
    return record.playerName ? [record.playerName] : [];
}

function mapLabel(record) {
    if (!record.mapHrid) return record.mapName || toolText("unknownMap", "Unknown Map");
    return translate(`actionNames.${record.mapHrid}`, record.mapName || record.mapHrid);
}

function makeCell(text, className = "") {
    const cell = document.createElement("td");
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
}

function makeHeader(text, className = "") {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
}

function addDetailRow(container, label, value) {
    const row = document.createElement("div");
    row.className = "d-flex justify-content-between gap-3 border-bottom py-1";
    const labelElement = document.createElement("span");
    labelElement.className = "text-muted";
    labelElement.textContent = label;
    const valueElement = document.createElement("span");
    valueElement.className = "text-end";
    valueElement.textContent = value;
    row.append(labelElement, valueElement);
    container.append(row);
}

function createDetailCard(title) {
    const card = document.createElement("section");
    card.className = "border rounded p-2 h-100";
    const heading = document.createElement("h6");
    heading.className = "mb-2";
    heading.textContent = title;
    card.append(heading);
    return card;
}

function addItemsTable(card, items, { showPerHour = false, valueLabel = "perDay" } = {}) {
    if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "text-muted";
        empty.textContent = toolText("noItems", "None");
        card.append(empty);
        return;
    }
    const table = document.createElement("table");
    table.className = "table table-sm mb-0";
    const header = document.createElement("thead");
    const headerRow = document.createElement("tr");
    headerRow.append(makeHeader(toolText("item", "Item")));
    if (showPerHour) {
        headerRow.append(makeHeader(toolText("perHour", "Per Hour"), "text-end"));
    }
    headerRow.append(makeHeader(toolText(valueLabel, "Per 24 Hours"), "text-end"));
    header.append(headerRow);
    const body = document.createElement("tbody");
    for (const item of items) {
        const row = document.createElement("tr");
        row.append(makeCell(item.name || itemNameFor(item.hrid)));
        if (showPerHour) {
            row.append(makeCell(formatHourlyQuantity(item.perHour), "text-end"));
        }
        row.append(makeCell(formatQuantity(item.quantity), "text-end"));
        body.append(row);
    }
    table.append(header, body);
    card.append(table);
}

function renderRecordDetails(record) {
    const root = document.createElement("div");
    root.className = "row g-2 mt-1";

    const coreCard = createDetailCard(toolText("coreResults", "Core Results"));
    addDetailRow(coreCard, toolText("eph", "EPH"), formatQuantity(record.metrics?.eph));
    addDetailRow(coreCard, toolText("deathsPerDay", "Deaths / 24h"), formatTwoDecimalQuantity(record.metrics?.deathsPerDay));
    addDetailRow(coreCard, toolText("shardsPerDay", "Fragments / 24h"), formatQuantity(record.metrics?.shardsPerDay));
    root.append(coreCard);
    coreCard.classList.add("col-12", "col-lg-6");

    const matchedCard = createDetailCard(toolText("matchedDrops", "Fragments and Charms"));
    addItemsTable(matchedCard, (record.matchedDrops || []).map((drop) => ({
        name: drop.name || itemNameFor(drop.hrid),
        quantity: drop.quantity,
    })));
    root.append(matchedCard);
    matchedCard.classList.add("col-12", "col-lg-6");

    const experienceCard = createDetailCard(toolText("experience", "Experience"));
    const playerExperience = (record.players || [])
        .slice(0, 5)
        .map((player) => ({
            name: player.name,
            items: (player.experience || []).filter((item) => roundToTwoDecimals(item.value) !== 0),
        }))
        .filter((player) => player.items.length > 0);
    if (playerExperience.length) {
        const experienceGrid = document.createElement("div");
        experienceGrid.className = `simulation-result-player-grid row row-cols-1 row-cols-md-2 row-cols-xl-${playerExperience.length} g-2`;
        for (const player of playerExperience) {
            const playerColumn = document.createElement("div");
            playerColumn.className = "col";
            const playerSection = document.createElement("section");
            playerSection.className = "simulation-result-player-card border rounded p-2 h-100";
            const playerHeading = document.createElement("h6");
            playerHeading.className = "mb-2 text-truncate";
            playerHeading.textContent = player.name;
            playerHeading.title = player.name;
            playerSection.append(playerHeading);
            addItemsTable(playerSection, player.items.map((item) => ({
                name: item.name,
                quantity: item.value,
            })), { valueLabel: "perHour" });
            playerColumn.append(playerSection);
            experienceGrid.append(playerColumn);
        }
        experienceCard.append(experienceGrid);
    } else {
        const experience = (record.experience || []).filter((item) => roundToTwoDecimals(item.value) !== 0);
        addItemsTable(experienceCard, experience.map((item) => ({
            name: item.name,
            quantity: item.value,
        })), { valueLabel: "perHour" });
    }
    root.append(experienceCard);
    experienceCard.classList.add("col-12");

    const consumablesCard = createDetailCard(toolText("consumablesByPlayer", "Consumables by Player"));
    const players = record.players?.slice(0, 5) || [];
    if (!players.some((player) => player.consumables?.length)) {
        const empty = document.createElement("div");
        empty.className = "text-muted";
        empty.textContent = toolText("noItems", "None");
        consumablesCard.append(empty);
    } else {
        const playerGrid = document.createElement("div");
        playerGrid.className = `simulation-result-player-grid row row-cols-1 row-cols-md-2 row-cols-xl-${players.length} g-2`;
        for (const player of players) {
            const playerColumn = document.createElement("div");
            playerColumn.className = "col";
            const playerSection = document.createElement("section");
            playerSection.className = "simulation-result-player-card border rounded p-2 h-100";
            const playerHeading = document.createElement("h6");
            playerHeading.className = "mb-2 text-truncate";
            playerHeading.textContent = player.name;
            playerHeading.title = player.name;
            playerSection.append(playerHeading);
            addDetailRow(
                playerSection,
                toolText("deathsPerDay", "Deaths / 24h"),
                formatTwoDecimalQuantity(player.deathsPerDay)
            );
            addItemsTable(playerSection, player.consumables || [], { showPerHour: true });
            playerColumn.append(playerSection);
            playerGrid.append(playerColumn);
        }
        consumablesCard.append(playerGrid);
    }
    root.append(consumablesCard);
    consumablesCard.classList.add("col-12");
    return root;
}

function getArchiveNotice() {
    return document.getElementById("simulationResultArchiveNotice");
}

function exportRecord(record) {
    const notice = getArchiveNotice();
    let exportData;
    try {
        exportData = createRecordExport(record);
    } catch (error) {
        console.error("Could not export saved player configuration.", error);
        setNotice(notice, toolText("exportError", "Could not export this saved configuration."), true);
        return;
    }
    if (!exportData) {
        setNotice(notice, toolText("exportUnavailable", "No configuration is available to export."), true);
        return;
    }

    const blob = new Blob([exportData.content], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportData.fileName;
    try {
        document.body.append(link);
        link.click();
    } finally {
        link.remove();
        URL.revokeObjectURL(url);
    }
    setNotice(notice, `${toolText("exported", "Exported")} ${exportData.fileName}`, false);
}

function renderArchive() {
    const root = document.getElementById("simulationResultArchiveGroups");
    const notice = getArchiveNotice();
    if (storageError) {
        setNotice(notice, toolText("storageError", "Could not read or write saved results."), true);
    } else if (records.length === 0) {
        setNotice(notice, toolText("emptyArchive", "No saved results yet."), false);
    } else {
        setNotice(notice, "", false);
    }
    root.replaceChildren();

    for (const group of groupArchiveRecords(records)) {
        const details = document.createElement("details");
        details.className = "mb-2 border rounded p-2";
        const summary = document.createElement("summary");
        summary.className = "fw-semibold";
        summary.textContent = `${mapLabel(group.records[0])} · ${group.difficulty} (${group.records.length})`;
        details.append(summary);

        for (const record of group.records) {
            const recordDetails = document.createElement("details");
            recordDetails.className = "border rounded p-2 mt-2";
            const recordSummary = document.createElement("summary");
            recordSummary.className = "d-flex flex-wrap align-items-center gap-2";

            const identity = document.createElement("span");
            identity.className = "me-auto";
            identity.textContent = [
                recordTitle(record),
                getPlayerNames(record).join(" / "),
            ].filter(Boolean).join(" · ");

            const stats = document.createElement("span");
            stats.className = "d-flex flex-wrap gap-2";
            for (const labelAndValue of [
                [`${toolText("eph", "EPH")} ${formatQuantity(record.metrics?.eph)}`, "text-bg-primary"],
                [`${toolText("deathsPerDay", "Deaths / 24h")} ${formatTwoDecimalQuantity(record.metrics?.deathsPerDay)}`, "text-bg-secondary"],
                [`${toolText("shardsPerDay", "Fragments / 24h")} ${formatQuantity(record.metrics?.shardsPerDay)}`, "text-bg-warning"],
            ]) {
                const badge = document.createElement("span");
                badge.className = `badge ${labelAndValue[1]}`;
                badge.textContent = labelAndValue[0];
                stats.append(badge);
            }

            const compareButton = document.createElement("button");
            compareButton.type = "button";
            compareButton.className = "btn btn-sm btn-outline-primary me-1";
            compareButton.textContent = toolText("compare", "Compare Drops");
            compareButton.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                openCompareWithRecord(record.id);
            });

            const deleteButton = document.createElement("button");
            deleteButton.type = "button";
            deleteButton.className = "btn btn-sm btn-outline-danger";
            deleteButton.textContent = toolText("delete", "Delete");
            deleteButton.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                deleteRecord(record.id);
            });
            const exportButton = document.createElement("button");
            exportButton.type = "button";
            exportButton.className = "btn btn-sm btn-outline-secondary me-1";
            exportButton.textContent = toolText("export", "Export");
            exportButton.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                exportRecord(record);
            });
            recordSummary.append(identity, stats, compareButton, exportButton, deleteButton);
            recordDetails.append(recordSummary, renderRecordDetails(record));
            details.append(recordDetails);
        }
        root.append(details);
    }
}

function getCurrentDrops() {
    return [...document.querySelectorAll("#simulationResultDrops .drop-inventory-tile")].map((tile) => ({
        hrid: tile.dataset.itemHrid || "",
        name: itemNameFor(tile.dataset.itemHrid),
        quantity: parseNumber(tile.dataset.quantity),
    }));
}

function getPlayerLabel(playerHrid) {
    const tab = document.getElementById(`${playerHrid}-tab`);
    return tab?.textContent.trim() || playerHrid;
}

function getExpectedDropsByPlayer(context, playerHrids, durationHours) {
    const getExpectedDropsForPlayer = context.getExpectedDropsForPlayer;
    const playerDrops = typeof getExpectedDropsForPlayer === "function"
        ? playerHrids.map((playerHrid) => ({
            playerHrid,
            drops: [...getExpectedDropsForPlayer(playerHrid)].map(([hrid, quantity]) => ({
                hrid,
                name: itemNameFor(hrid),
                quantity: normalizeTo24Hours(quantity, durationHours),
            })),
        }))
        : [{
            playerHrid: playerHrids[0],
            drops: getCurrentDrops().map((drop) => ({
                ...drop,
                quantity: normalizeTo24Hours(drop.quantity, durationHours),
            })),
        }];
    return playerDrops;
}

function getTeamExpectedDrops(playerExpectedDrops) {
    const combined = new Map();
    for (const { drops } of playerExpectedDrops) {
        for (const drop of drops) {
            const existing = combined.get(drop.hrid);
            if (existing) {
                existing.quantity += drop.quantity;
            } else {
                combined.set(drop.hrid, { ...drop });
            }
        }
    }
    return [...combined.values()];
}

function saveCurrentResult() {
    const notice = getArchiveNotice();
    if (!latestResultContext) {
        setNotice(notice, toolText("noCurrentResult", "Run a simulation before saving a result."), true);
        return;
    }

    const { simResult } = latestResultContext;
    const playerHrids = latestResultContext.playerHrids.length
        ? latestResultContext.playerHrids
        : ["player1"];
    const durationHours = simResult.simulatedTime / ONE_HOUR;
    if (!Number.isFinite(durationHours) || durationHours <= 0) {
        setNotice(notice, toolText("noCurrentResult", "Run a simulation before saving a result."), true);
        return;
    }
    const isDungeon = Boolean(simResult.isDungeon);
    const playerExpectedDrops = getExpectedDropsByPlayer(latestResultContext, playerHrids, durationHours);
    const expectedDrops = getTeamExpectedDrops(playerExpectedDrops);
    const shardsPerPlayer = playerExpectedDrops.map(({ drops }) =>
        drops
            .filter((drop) => classifyDropCategory(drop.hrid) === "fragments")
            .reduce((total, drop) => total + drop.quantity, 0)
    );
    const players = playerHrids.map((playerHrid, index) => {
        const deaths = Number(simResult.deaths[playerHrid] || 0);
        const experience = simResult.experienceGained[playerHrid] || {};
        const totalExperience = Object.values(experience).reduce((total, value) => total + value, 0);
        const consumables = Object.entries(simResult.consumablesUsed[playerHrid] || {})
            .map(([hrid, count]) => {
                const perHour = Number(count) / durationHours;
                return {
                    hrid,
                    name: itemNameFor(hrid),
                    perHour,
                    quantity: perHour * 24,
                };
            })
            .sort((a, b) => b.quantity - a.quantity);

        return {
            hrid: playerHrid,
            name: getPlayerLabel(playerHrid),
            deathsPerHour: deaths / durationHours,
            deathsPerDay: roundToTwoDecimals(normalizeTo24Hours(deaths, durationHours)),
            shardsPerDay: shardsPerPlayer[index] || 0,
            experience: [
                { name: toolText("total", "Total"), value: totalExperience / durationHours },
                ...Object.entries(experience).map(([skill, value]) => ({
                    name: translate(`leaderboardCategoryNames.${skill}`, skill),
                    value: value / durationHours,
                })),
            ],
            consumables,
        };
    });
    const mapHrid = simResult.isLabyrinth
        ? simResult.labyrinthName
        : simResult.zoneName;
    const mapName = mapHrid ? translate(`actionNames.${mapHrid}`, mapHrid) : "";
    const difficulty = simResult.roomLevel !== undefined && simResult.isLabyrinth
        ? `L${simResult.roomLevel}`
        : simResult.difficultyTier !== undefined
            ? `T${simResult.difficultyTier}`
            : "?";
    const shardsPerDay = minimumPlayerShardDropCount(shardsPerPlayer);
    const savedRecord = roundSavedResultValues({
        id: `result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        schemaVersion: 2,
        savedAt: Date.now(),
        mapHrid: mapHrid || "",
        mapName: mapName || toolText("unknownMap", "Unknown Map"),
        difficulty,
        mode: toolText(
            isDungeon ? "dungeon" : simResult.isLabyrinth ? "labyrinth" : "zone",
            isDungeon ? "Dungeon" : simResult.isLabyrinth ? "Labyrinth" : "Zone"
        ),
        simulationHours: durationHours,
        playerNames: players.map((player) => player.name),
        players,
        configuration: {
            simulationHours: durationHours,
            simDungeon: isDungeon,
            simAllZone: Boolean(document.getElementById("simAllZoneToggle")?.checked),
            simAllSolo: Boolean(document.getElementById("simAllSoloToggle")?.checked),
            groupJson: latestResultContext.getGroupConfigJson?.() || "",
        },
        metrics: {
            eph: calculateSimulationEph(simResult),
            deathsPerDay: players.reduce((total, player) => total + player.deathsPerDay, 0),
            deathsPerHour: players.reduce((total, player) => total + player.deathsPerHour, 0),
            shardsPerDay,
        },
        matchedDrops: expectedDrops.filter((drop) =>
            ["fragments", "charms"].includes(classifyDropCategory(drop.hrid))
        ),
    });

    const previousRecords = records;
    try {
        records = [savedRecord, ...records].slice(0, MAX_RECORDS);
        persistRecords();
        setNotice(notice, toolText("saved", "Result saved."), false);
        renderArchive();
        renderCompareOptions();
    } catch {
        records = previousRecords;
        setNotice(notice, toolText("storageError", "Could not read or write saved results."), true);
    }
}

function deleteRecord(id) {
    const previousRecords = records;
    records = records.filter((record) => record.id !== id);
    try {
        persistRecords();
        renderArchive();
        renderCompareOptions();
    } catch {
        records = previousRecords;
        renderArchive();
    }
}

function clearRecords() {
    if (!window.confirm(toolText("confirmClear", "Delete all saved results?"))) return;
    const previousRecords = records;
    records = [];
    try {
        persistRecords();
        renderArchive();
        renderCompareOptions();
    } catch {
        records = previousRecords;
        renderArchive();
    }
}

function getRecordOptionLabel(record) {
    return `${mapLabel(record)} · ${record.difficulty} · ${recordTitle(record)}`;
}

function renderCompareOptions(selectA = "", selectB = "") {
    const selectOne = document.getElementById("simulationResultCompareA");
    const selectTwo = document.getElementById("simulationResultCompareB");
    const sortedRecords = records.slice().sort((a, b) => b.savedAt - a.savedAt);
    for (const select of [selectOne, selectTwo]) {
        select.replaceChildren();
        const emptyOption = document.createElement("option");
        emptyOption.value = "";
        emptyOption.textContent = toolText("selectRecord", "Select a saved result");
        select.append(emptyOption);
        for (const record of sortedRecords) {
            const option = document.createElement("option");
            option.value = record.id;
            option.textContent = getRecordOptionLabel(record);
            select.append(option);
        }
    }
    selectOne.value = selectA || sortedRecords[0]?.id || "";
    selectTwo.value = selectB || sortedRecords[1]?.id || "";
    renderComparison();
}

export function getComparableItems(record) {
    const items = [];
    const drops = record.drops?.length ? record.drops : record.matchedDrops || [];
    for (const drop of drops) {
        const hrid = drop.hrid || "";
        items.push({
            key: `drop:${hrid || drop.name}`,
            category: classifyDropCategory(hrid),
            name: hrid ? itemNameFor(hrid) : drop.name,
            quantity: Number(drop.quantity) || 0,
        });
    }

    for (const player of record.players || []) {
        for (const item of player.consumables || []) {
            const hrid = item.hrid || "";
            items.push({
                key: `consumable:${player.hrid || player.name}:${hrid || item.name}`,
                category: "consumables",
                name: `${player.name}: ${hrid ? itemNameFor(hrid) : item.name}`,
                quantity: Number(item.quantity) || 0,
            });
        }
    }
    return items;
}

function renderComparison() {
    const rows = document.getElementById("simulationResultCompareRows");
    const notice = document.getElementById("simulationResultCompareNotice");
    const selectedCategories = new Set(
        [...document.querySelectorAll("#simulationResultCompareCategories input:checked")]
            .map((input) => input.dataset.category)
    );
    const recordA = records.find((record) => record.id === document.getElementById("simulationResultCompareA").value);
    const recordB = records.find((record) => record.id === document.getElementById("simulationResultCompareB").value);
    rows.replaceChildren();

    if (!recordA || !recordB) {
        setNotice(notice, toolText("selectTwoRecords", "Select two saved results to compare."), false);
        return;
    }
    setNotice(notice, "", false);

    const itemsA = new Map(getComparableItems(recordA).map((item) => [item.key, item]));
    const itemsB = new Map(getComparableItems(recordB).map((item) => [item.key, item]));
    const allItems = new Set([...itemsA.keys(), ...itemsB.keys()]);
    const visibleDrops = [...allItems]
        .map((key) => {
            const item = itemsB.get(key) || itemsA.get(key);
            return {
                name: item.name,
                category: item.category,
                valueA: itemsA.get(key)?.quantity || 0,
                valueB: itemsB.get(key)?.quantity || 0,
            };
        })
        .filter((item) => selectedCategories.has(item.category))
        .sort((a, b) => a.name.localeCompare(b.name));

    if (visibleDrops.length === 0) {
        const row = document.createElement("tr");
        const cell = makeCell(toolText("noMatchingDrops", "No matching drops in the selected categories."));
        cell.colSpan = 5;
        cell.className = "text-center text-muted";
        row.append(cell);
        rows.append(row);
        return;
    }

    for (const drop of visibleDrops) {
        const difference = drop.valueB - drop.valueA;
        const tone = comparisonTone(drop.valueA, drop.valueB);
        const percent = drop.valueA === 0
            ? (drop.valueB === 0 ? "-" : "∞")
            : `${((difference / drop.valueA) * 100).toFixed(2)}%`;
        const row = document.createElement("tr");
        row.append(
            makeCell(drop.name),
            makeCell(formatQuantity(drop.valueA), "text-end"),
            makeCell(formatQuantity(drop.valueB), "text-end"),
            makeCell(formatQuantity(difference), `text-end ${tone}`),
            makeCell(percent, `text-end ${tone}`)
        );
        rows.append(row);
    }
}

function openCompareWithRecord(id) {
    const otherRecord = records.find((record) => record.id !== id);
    renderCompareOptions(id, otherRecord?.id || "");
    const archiveModal = document.getElementById("simulationResultArchiveModal");
    const compareModal = document.getElementById("simulationResultCompareModal");
    archiveModal.addEventListener("hidden.bs.modal", () => {
        bootstrap.Modal.getOrCreateInstance(compareModal).show();
    }, { once: true });
    bootstrap.Modal.getOrCreateInstance(archiveModal).hide();
}

export function setCurrentSimulationResult(simResult, playerHrids, getExpectedDropsForPlayer, getGroupConfigJson) {
    latestResultContext = {
        simResult,
        playerHrids,
        getExpectedDropsForPlayer,
        getGroupConfigJson,
    };
}

export function initSimulationResultTools() {
    records = loadRecords();
    document.getElementById("buttonSaveSimulationResult").addEventListener("click", saveCurrentResult);
    document.getElementById("buttonClearSimulationResults").addEventListener("click", clearRecords);
    document.getElementById("simulationResultArchiveModal").addEventListener("show.bs.modal", renderArchive);
    document.getElementById("simulationResultCompareModal").addEventListener("show.bs.modal", () => {
        renderCompareOptions(
            document.getElementById("simulationResultCompareA").value,
            document.getElementById("simulationResultCompareB").value
        );
    });
    document.getElementById("simulationResultCompareA").addEventListener("change", renderComparison);
    document.getElementById("simulationResultCompareB").addEventListener("change", renderComparison);
    document.getElementById("simulationResultCompareCategories").addEventListener("change", renderComparison);
    renderArchive();
    renderCompareOptions();
}
