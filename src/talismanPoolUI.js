import Equipment from "./combatsimulator/equipment";
import {
    countTalismanPoolCombinations,
    createTalismanOptimizer,
    generateTalismanPoolCombinations,
} from "./talismanOptimizer";
import {
    CANDIDATE_PRESETS_KEY, deleteNamedPoolPreset, readNamedPoolPresets,
    validateCandidatePreset, writeNamedPoolPreset,
} from "./talismanPoolPresets";

export function initTalismanPool({ getSnapshot, modifierMap, supportedStats, planetHrids, createWorker, preparePlayers, savePlayerResult }) {
    const modal = document.getElementById("talismanPoolModal");
    const settings = document.getElementById("talismanPoolSettings");
    const playerContainer = document.getElementById("talismanPoolPlayers");
    const estimate = document.getElementById("talismanPoolEstimate");
    const status = document.getElementById("talismanPoolStatus");
    const start = document.getElementById("buttonStartTalismanPool");
    const stop = document.getElementById("buttonStopTalismanPool");
    const headers = document.getElementById("talismanPoolResultHeaders");
    const completedBody = document.getElementById("talismanPoolCompleted");
    const partialBody = document.getElementById("talismanPoolPartial");
    const ordinaryGrade = document.getElementById("talismanPoolOrdinaryGrade");
    const specialGrade = document.getElementById("talismanPoolSpecialGrade");
    const threadsInput = document.getElementById("talismanPoolThreads");
    const repeatsInput = document.getElementById("talismanPoolRepeats");
    const resultName = document.getElementById("talismanPoolResultName");
    const zoneSelect = document.getElementById("talismanPoolZone");
    const difficultySelect = document.getElementById("talismanPoolDifficulty");
    const text = (key, values = {}) => i18next.t(`common:talismanPool.${key}`, values);
    const supported = new Set(supportedStats);
    const planets = new Set(planetHrids);
    const modifiers = Object.values(modifierMap)
        .filter((modifier) => modifier.talismanTypeHrid === "/talisman_types/combat")
        .filter((modifier) => modifier.keys.every((key) => supported.has(key.charAt(0).toLowerCase() + key.slice(1))))
        .sort((a, b) => a.sortIndex - b.sortIndex);
    const special = modifiers.filter((modifier) => modifier.groupHrid === "/talisman_modifier_groups/special");
    const ordinary = modifiers.filter((modifier) => modifier.groupHrid !== "/talisman_modifier_groups/special");
    const ordinaryHrids = new Set(ordinary.map((modifier) => modifier.hrid));
    const specialHrids = new Set(special.map((modifier) => modifier.hrid));
    let snapshot = null;
    let cards = [];
    let optimizer = null;
    let cancelled = false;

    for (const select of [ordinaryGrade, specialGrade]) {
        for (let grade = 1; grade <= 6; grade++) select.add(new Option(`G${grade}`, grade - 1));
    }
    ordinaryGrade.value = "2";
    specialGrade.value = "5";

    const nameOf = (modifier) => modifier.keys.map((key) => {
        const stat = key.charAt(0).toLowerCase() + key.slice(1);
        return i18next.t(`combatStats.${stat}`, { defaultValue: modifier.name });
    }).join(" / ");
    const setStatus = (message, isError = false) => {
        status.textContent = message;
        status.classList.toggle("text-danger", isError);
    };
    const selectedCards = () => cards.filter((card) => card.enabled.checked);
    const selectedValues = (container) => [...container.querySelectorAll("input:checked")].map((input) => input.value);
    const groupKeysFor = (values) => values.map((hrid) => modifierMap[hrid].keys.join("|"));
    const countFor = (card) => {
        const regular = selectedValues(card.ordinary);
        return countTalismanPoolCombinations(
            regular.length, selectedValues(card.special).length, card.slots, groupKeysFor(regular)
        );
    };
    const renderEstimate = () => {
        const selected = selectedCards();
        for (const card of cards) {
            card.body.hidden = !card.enabled.checked;
            card.count.textContent = `${text("slots")}: ${card.slots} · ${text("combinations")}: ${countFor(card).toLocaleString()}`;
        }
        if (selected.length !== 3) {
            estimate.textContent = text("invalidPlayers");
            return;
        }
        const invalid = selected.find((card) => countFor(card) === 0);
        if (invalid) {
            estimate.textContent = text("invalidCombination", { player: invalid.name });
            return;
        }
        const groups = selected.reduce((total, card) => total + countFor(card), 0);
        const repeats = Number(repeatsInput.value);
        estimate.textContent = text("estimate", {
            groups: groups.toLocaleString(),
            runs: Number.isInteger(repeats) && repeats > 0 ? repeats : 0,
        });
    };

    const createChoices = (list, selected, title) => {
        const details = document.createElement("details");
        details.className = "border rounded p-2 mb-2";
        const summary = document.createElement("summary");
        summary.className = "small fw-semibold";
        summary.textContent = title;
        details.append(summary);
        const options = document.createElement("div");
        options.className = "mt-2";
        for (const modifier of list) {
            const label = document.createElement("label");
            label.className = "form-check small";
            const input = document.createElement("input");
            input.className = "form-check-input";
            input.type = "checkbox";
            input.value = modifier.hrid;
            input.checked = selected.has(modifier.hrid);
            const caption = document.createElement("span");
            caption.className = "form-check-label";
            caption.textContent = nameOf(modifier);
            label.append(input, caption);
            options.append(label);
        }
        details.append(options);
        return { details, options };
    };

    const presetError = (error) => {
        console.error("Could not use talisman pool presets.", error);
        setStatus(text("presetError", { error: error.message }), true);
    };
    const renderCandidateSelects = (selectedName, selectedCard) => {
        const presets = readNamedPoolPresets(localStorage, CANDIDATE_PRESETS_KEY);
        for (const card of cards) {
            const value = card === selectedCard ? selectedName : card.presetSelect.value;
            card.presetSelect.replaceChildren(new Option(text("selectPreset"), ""));
            for (const preset of presets) card.presetSelect.add(new Option(preset.name, preset.name));
            card.presetSelect.value = presets.some((preset) => preset.name === value) ? value : "";
        }
    };
    const createCandidateControls = (ordinaryOptions, specialOptions) => {
        const root = document.createElement("div");
        root.className = "border-top pt-2";
        const input = document.createElement("input");
        input.className = "form-control form-control-sm mb-1";
        input.type = "text";
        input.maxLength = 40;
        input.placeholder = text("candidateName");
        input.setAttribute("aria-label", text("candidateName"));
        const caption = document.createElement("div");
        caption.className = "small text-muted mb-1";
        caption.textContent = text("candidateGrades");
        const select = document.createElement("select");
        select.className = "form-select form-select-sm mb-1";
        select.setAttribute("aria-label", text("selectPreset"));
        const actions = document.createElement("div");
        actions.className = "d-flex gap-1";
        const button = (key) => {
            const element = document.createElement("button");
            element.type = "button";
            element.className = key === "delete" ? "btn btn-sm btn-outline-danger" : "btn btn-sm btn-outline-primary";
            element.textContent = text(key);
            actions.append(element);
            return element;
        };
        const save = button("save");
        const load = button("load");
        const remove = button("delete");
        const cardForSelect = () => cards.find((card) => card.presetSelect === select);
        save.addEventListener("click", () => {
            const name = input.value.trim();
            if (!name) {
                setStatus(text("nameRequired"), true);
                input.focus();
                return;
            }
            try {
                const presets = readNamedPoolPresets(localStorage, CANDIDATE_PRESETS_KEY);
                if (presets.some((preset) => preset.name === name)
                    && !window.confirm(text("confirmOverwrite", { name }))) return;
                const preset = {
                    name,
                    ordinary: selectedValues(ordinaryOptions),
                    special: selectedValues(specialOptions),
                    ordinaryGrade: Number(ordinaryGrade.value),
                    specialGrade: Number(specialGrade.value),
                };
                validateCandidatePreset(preset, ordinaryHrids, specialHrids);
                writeNamedPoolPreset(localStorage, CANDIDATE_PRESETS_KEY, preset);
                renderCandidateSelects(name, cardForSelect());
                setStatus(text("candidateSaved"));
            } catch (error) {
                presetError(error);
            }
        });
        load.addEventListener("click", () => {
            if (!select.value) {
                setStatus(text("selectRequired"), true);
                return;
            }
            try {
                const preset = readNamedPoolPresets(localStorage, CANDIDATE_PRESETS_KEY)
                    .find((entry) => entry.name === select.value);
                if (!preset) throw new Error("Saved candidate preset not found.");
                validateCandidatePreset(preset, ordinaryHrids, specialHrids);
                for (const [container, values] of [[ordinaryOptions, preset.ordinary], [specialOptions, preset.special]]) {
                    for (const checkbox of container.querySelectorAll("input")) checkbox.checked = values.includes(checkbox.value);
                }
                ordinaryGrade.value = String(preset.ordinaryGrade);
                specialGrade.value = String(preset.specialGrade);
                input.value = preset.name;
                renderEstimate();
                setStatus(text("candidateLoaded"));
            } catch (error) {
                presetError(error);
            }
        });
        remove.addEventListener("click", () => {
            if (!select.value) {
                setStatus(text("selectRequired"), true);
                return;
            }
            try {
                deleteNamedPoolPreset(localStorage, CANDIDATE_PRESETS_KEY, select.value);
                renderCandidateSelects("", cardForSelect());
                setStatus(text("presetDeleted"));
            } catch (error) {
                presetError(error);
            }
        });
        root.append(input, caption, select, actions);
        return { root, select };
    };

    const renderPlayers = () => {
        const previous = new Map(cards.map((card) => [card.player.hrid, {
            enabled: card.enabled.checked,
            ordinary: selectedValues(card.ordinary),
            special: selectedValues(card.special),
            preset: card.presetSelect.value,
        }]));
        playerContainer.replaceChildren();
        cards = snapshot.players.map((player, index) => {
            const saved = previous.get(player.hrid);
            const belt = player.equipment["/equipment_types/belt"];
            const slots = belt ? Math.min(12, Math.max(0, Math.floor(Equipment.createFromDTO(belt).getCombatStat("talismanSlots") * 4))) : 0;
            const column = document.createElement("div");
            column.className = "col-12 col-lg-4";
            const box = document.createElement("div");
            box.className = "border rounded p-2 h-100";
            const label = document.createElement("label");
            label.className = "form-check fw-semibold";
            const enabled = document.createElement("input");
            enabled.className = "form-check-input";
            enabled.type = "checkbox";
            enabled.checked = saved ? saved.enabled : index < 3;
            const caption = document.createElement("span");
            caption.className = "form-check-label";
            caption.textContent = snapshot.names[index] || player.hrid;
            label.append(enabled, caption);
            const count = document.createElement("div");
            count.className = "small mb-2";
            const body = document.createElement("div");
            const ordinaryChoices = createChoices(ordinary, new Set(saved?.ordinary || []), text("ordinary"));
            const specialChoices = createChoices(special, new Set(saved?.special || []), text("special"));
            const presetControls = createCandidateControls(ordinaryChoices.options, specialChoices.options);
            body.append(ordinaryChoices.details, specialChoices.details, presetControls.root);
            box.append(label, count, body);
            column.append(box);
            playerContainer.append(column);
            return {
                player, name: caption.textContent, slots, enabled, count, body,
                ordinary: ordinaryChoices.options, special: specialChoices.options,
                presetSelect: presetControls.select, previousPreset: saved?.preset || "",
            };
        });
        renderCandidateSelects();
        for (const card of cards) card.presetSelect.value = card.previousPreset;
        renderEstimate();
    };

    playerContainer.addEventListener("change", renderEstimate);
    repeatsInput.addEventListener("input", renderEstimate);
    modal.addEventListener("show.bs.modal", () => {
        if (optimizer) return;
        try {
            for (const [target, source] of [[zoneSelect, document.getElementById("selectZone")],
                [difficultySelect, document.getElementById("selectDifficulty")]]) {
                const value = target.value || source.value;
                target.replaceChildren(...[...source.options].filter((option) =>
                    target !== zoneSelect || planets.has(option.value)
                ).map((option) => {
                    const copy = option.cloneNode(true);
                    copy.disabled = false;
                    return copy;
                }));
                target.value = [...target.options].some((option) => option.value === value)
                    ? value : target.options[0]?.value || "";
            }
            snapshot = getSnapshot();
            renderPlayers();
            setStatus("");
            start.disabled = false;
        } catch (error) {
            console.error("Could not prepare talisman pool simulation.", error);
            snapshot = null;
            start.disabled = true;
            setStatus(text("error", { error: error.message }), true);
        }
    });

    start.addEventListener("click", async () => {
        if (!snapshot || optimizer) return;
        const selected = selectedCards();
        if (selected.length !== 3) {
            setStatus(text("invalidPlayers"), true);
            return;
        }
        const threads = Number(threadsInput.value);
        const repeats = Number(repeatsInput.value);
        if (!Number.isInteger(threads) || threads < 1 || threads > 32
            || !Number.isInteger(repeats) || repeats < 1 || repeats > 100) {
            setStatus(text("invalidNumbers"), true);
            return;
        }
        const invalid = selected.find((card) => countFor(card) === 0);
        if (invalid) {
            setStatus(text("invalidCombination", { player: invalid.name }), true);
            return;
        }
        const grade = Number(ordinaryGrade.value);
        const specialLevel = Number(specialGrade.value);
        if (!zoneSelect.value || difficultySelect.value === "") {
            setStatus(text("invalidZone"), true);
            return;
        }
        const sets = selected.map((card) => {
            const regular = selectedValues(card.ordinary);
            const specialCandidates = selectedValues(card.special);
            return {
                count: countFor(card),
                create: () => generateTalismanPoolCombinations(regular, specialCandidates, card.slots, grade, specialLevel, groupKeysFor(regular)),
            };
        });
        headers.replaceChildren();
        for (const name of [text("eph"), ...selected.map((card) => card.name)]) {
            const th = document.createElement("th");
            th.scope = "col";
            th.textContent = name;
            headers.append(th);
        }
        completedBody.replaceChildren();
        partialBody.replaceChildren();
        const rows = new Map();
        const sorted = [];
        const formatTeam = (selections) => {
            const counts = new Map();
            for (const selection of selections) {
                const key = `${selection.modifierHrid}|${selection.gradeIndex}`;
                counts.set(key, (counts.get(key) || 0) + 1);
            }
            return [...counts].map(([key, count]) => {
                const [hrid, gradeIndex] = key.split("|");
                return `${nameOf(modifierMap[hrid])} G${Number(gradeIndex) + 1} ×${count}`;
            }).join(" · ") || "—";
        };
        const updateResult = (record) => {
            let row = rows.get(record.key);
            if (!row) {
                row = document.createElement("tr");
                for (let i = 0; i < 4; i++) row.append(document.createElement("td"));
                record.team.forEach((combination, index) => {
                    const caption = document.createElement("div");
                    caption.textContent = formatTeam(combination);
                    const save = document.createElement("button");
                    save.type = "button";
                    save.className = "btn btn-sm btn-outline-primary mt-1";
                    save.textContent = text("save");
                    save.disabled = true;
                    save.addEventListener("click", () => {
                        const name = resultName.value.trim();
                        if (!name) {
                            setStatus(text("nameRequired"), true);
                            resultName.focus();
                            return;
                        }
                        try {
                            if (savePlayerResult(name, combination)) {
                                setStatus(text("playerSaved", { player: selected[index].name }));
                            }
                        } catch (error) {
                            presetError(error);
                        }
                    });
                    row.cells[index + 1].append(caption, save);
                });
                partialBody.append(row);
                rows.set(record.key, row);
            }
            row.cells[0].textContent = `${record.eph.toFixed(4)}${record.completed < record.repeats ? ` (${record.completed}/${record.repeats})` : ""}`;
            if (record.completed === record.repeats) {
                if (record.phase === "review") row.querySelectorAll("button").forEach((button) => { button.disabled = false; });
                let low = 0;
                let high = sorted.length;
                while (low < high) {
                    const mid = Math.floor((low + high) / 2);
                    if (sorted[mid].eph >= record.eph) low = mid + 1;
                    else high = mid;
                }
                completedBody.insertBefore(row, sorted[low]?.row || null);
                sorted.splice(low, 0, { eph: record.eph, row });
            }
        };
        cancelled = false;
        settings.disabled = true;
        start.disabled = true;
        stop.disabled = false;
        setStatus(text("baseline"));
        try {
            optimizer = createTalismanOptimizer({
                players: preparePlayers(selected.map((card) => card.player)),
                candidateSets: sets,
                repeats,
                threads,
                message: { ...snapshot.message, zone: { zoneHrid: zoneSelect.value, difficultyTier: Number(difficultySelect.value) } },
                createWorker,
                onResult: updateResult,
                onProgress: (progress) => setStatus(text("progress", {
                    round: progress.round,
                    player: selected[progress.playerIndex].name,
                    done: progress.completed.toLocaleString(),
                    total: progress.total.toLocaleString(),
                    evaluated: progress.evaluated.toLocaleString(),
                })),
                onReviewStart: ({ total }) => {
                    rows.clear();
                    sorted.length = 0;
                    completedBody.replaceChildren();
                    partialBody.replaceChildren();
                    setStatus(text("reviewing", { done: 0, total }));
                },
                onReviewProgress: ({ completed, total }) => setStatus(text("reviewing", { done: completed, total })),
            });
            await optimizer.run();
            setStatus(text("finished"));
        } catch (error) {
            if (cancelled) setStatus(text("stopped"));
            else {
                console.error("Talisman pool simulation failed.", error);
                setStatus(text("error", { error: error.message }), true);
            }
        } finally {
            optimizer = null;
            settings.disabled = false;
            start.disabled = false;
            stop.disabled = true;
        }
    });
    stop.addEventListener("click", () => {
        if (optimizer) {
            cancelled = true;
            stop.disabled = true;
            optimizer.stop();
        }
    });
}
