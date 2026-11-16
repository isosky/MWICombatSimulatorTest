export const CONSUMABLE_PRESET_STORAGE_KEY = "mwicFoodConfigV7";
export const LEGACY_CONSUMABLE_PRESET_STORAGE_KEY = "mwicConfigV6";
export const CONSUMABLE_PRESET_COUNT = 10;
export const CONSUMABLE_SLOT_COUNT = 3;

function normalizeSlot(source = {}) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw new Error("Invalid consumable preset.");
    }
    const normalizeItems = (items) => {
        if (items !== undefined && !Array.isArray(items)) throw new Error("Invalid consumable preset items.");
        return Array.from({ length: CONSUMABLE_SLOT_COUNT }, (_, index) => {
            const value = items?.[index] ?? "";
            if (typeof value !== "string") throw new Error("Invalid consumable preset item.");
            return value;
        });
    };
    return { foods: normalizeItems(source.foods), drinks: normalizeItems(source.drinks) };
}

export function readConsumablePresetStorage(storage) {
    const saved = storage.getItem(CONSUMABLE_PRESET_STORAGE_KEY);
    const legacy = saved === null ? storage.getItem(LEGACY_CONSUMABLE_PRESET_STORAGE_KEY) : null;
    const parsed = JSON.parse(saved ?? legacy ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || (parsed.food !== undefined && (!parsed.food || typeof parsed.food !== "object" || Array.isArray(parsed.food)))) {
        throw new Error("Invalid consumable preset storage.");
    }
    const food = {};
    for (let index = 1; index <= CONSUMABLE_PRESET_COUNT; index++) {
        const key = legacy !== null ? String.fromCharCode(64 + index) : String(index);
        food[String(index)] = normalizeSlot(parsed.food?.[key]);
    }
    return { ...parsed, food, panelState: { ...parsed.panelState, isOpen: Boolean(parsed.panelState?.isOpen) } };
}

export function applyConsumablePresetToPlayer(playerData, preset, itemMap) {
    const result = structuredClone(playerData);
    const combatAction = "/action_types/combat";
    if (!result.food || !result.drinks) {
        throw new Error("Invalid player consumable configuration.");
    }
    if (result.triggerMap === undefined) result.triggerMap = {};
    if (!result.triggerMap || typeof result.triggerMap !== "object" || Array.isArray(result.triggerMap)) {
        throw new Error("Invalid player trigger configuration.");
    }
    const normalized = normalizeSlot(preset);
    result.food[combatAction] = normalized.foods.map((itemHrid) => ({ itemHrid }));
    result.drinks[combatAction] = normalized.drinks.map((itemHrid) => ({ itemHrid }));
    for (const hrid of [...normalized.foods, ...normalized.drinks]) {
        if (hrid && !result.triggerMap[hrid]) {
            const triggers = itemMap[hrid]?.consumableDetail?.defaultCombatTriggers;
            if (!triggers) throw new Error(`Unknown consumable: ${hrid}`);
            result.triggerMap[hrid] = structuredClone(triggers);
        }
    }
    return result;
}
