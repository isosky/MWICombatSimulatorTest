export const CANDIDATE_PRESETS_KEY = "talismanPoolCandidatePresets";
export const TEAM_PRESETS_KEY = "talismanPoolTeamPresets";

export function readNamedPoolPresets(storage, key) {
    const presets = JSON.parse(storage.getItem(key) ?? "[]");
    if (!Array.isArray(presets) || presets.some((preset) =>
        !preset || typeof preset !== "object" || typeof preset.name !== "string" || !preset.name.trim()
    )) {
        throw new Error("Invalid saved talisman presets.");
    }
    return presets;
}

export function writeNamedPoolPreset(storage, key, preset) {
    if (typeof preset.name !== "string" || !preset.name.trim()) throw new Error("Preset name is required.");
    const presets = readNamedPoolPresets(storage, key);
    const index = presets.findIndex((entry) => entry.name === preset.name);
    if (index < 0) presets.push(preset);
    else presets[index] = preset;
    storage.setItem(key, JSON.stringify(presets));
}

export function deleteNamedPoolPreset(storage, key, name) {
    const presets = readNamedPoolPresets(storage, key);
    storage.setItem(key, JSON.stringify(presets.filter((preset) => preset.name !== name)));
}

export function validateCandidatePreset(preset, ordinaryHrids, specialHrids) {
    const validList = (values, allowed) => Array.isArray(values)
        && values.every((value) => typeof value === "string" && allowed.has(value))
        && new Set(values).size === values.length;
    const validGrade = (grade) => Number.isInteger(grade) && grade >= 0 && grade <= 5;
    if (!validList(preset.ordinary, ordinaryHrids) || !validList(preset.special, specialHrids)
        || !validGrade(preset.ordinaryGrade) || !validGrade(preset.specialGrade)) {
        throw new Error("Invalid or unavailable talisman candidate preset.");
    }
}

export function validateTeamPreset(preset, modifierHrids) {
    if (!Array.isArray(preset.players) || preset.players.length !== 3
        || new Set(preset.players.map((entry) => entry?.hrid)).size !== 3) {
        throw new Error("Invalid saved talisman team.");
    }
    for (const entry of preset.players) {
        if (!entry || !/^player[1-5]$/.test(entry.hrid) || !Array.isArray(entry.selections)
            || entry.selections.length > 12 || entry.selections.some((selection) =>
                !selection || !modifierHrids.has(selection.modifierHrid)
                || !Number.isInteger(selection.gradeIndex) || selection.gradeIndex < 0 || selection.gradeIndex > 5
            )) {
            throw new Error("Invalid or unavailable saved talisman selection.");
        }
    }
}
