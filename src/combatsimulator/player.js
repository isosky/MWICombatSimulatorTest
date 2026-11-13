import Ability from "./ability";
import CombatUnit from "./combatUnit";
import Consumable from "./consumable";
import Equipment from "./equipment";
import HouseRoom from "./houseRoom";
import Achievement from "./achievement";
import talismanModifierDetailMap from "./data/talismanModifierDetailMap.json";

class Player extends CombatUnit {
    static combatEquipmentStats = [
        "stabAccuracy", "slashAccuracy", "smashAccuracy", "rangedAccuracy", "magicAccuracy",
        "stabDamage", "slashDamage", "smashDamage", "rangedDamage", "magicDamage", "defensiveDamage",
        "taskDamage", "physicalAmplify", "waterAmplify", "natureAmplify", "fireAmplify", "healingAmplify",
        "stabEvasion", "slashEvasion", "smashEvasion", "rangedEvasion", "magicEvasion", "armor",
        "waterResistance", "natureResistance", "fireResistance", "damageTaken", "maxHitpoints", "maxManapoints",
        "lifeSteal", "hpRegenPer10", "mpRegenPer10", "physicalThorns", "elementalThorns",
        "combatDropRate", "combatRareFind", "combatDropQuantity", "combatExperience", "criticalRate",
        "criticalDamage", "shatter", "echo", "smite", "overkill", "armorPenetration", "waterPenetration", "naturePenetration", "firePenetration",
        "abilityHaste", "tenacity", "manaLeech", "castSpeed", "threat", "parry", "mayhem", "pierce",
        "curse", "fury", "weaken", "ripple", "bloom", "blaze", "attackSpeed", "foodHaste",
        "drinkConcentration", "autoAttackDamage", "abilityDamage", "staminaExperience", "intelligenceExperience",
        "attackExperience", "defenseExperience", "meleeExperience", "rangedExperience", "magicExperience",
        "retaliation",
    ];
    talismanModifiers = [];
    equipment = {
        "/equipment_types/head": null,
        "/equipment_types/body": null,
        "/equipment_types/legs": null,
        "/equipment_types/feet": null,
        "/equipment_types/hands": null,
        "/equipment_types/main_hand": null,
        "/equipment_types/two_hand": null,
        "/equipment_types/off_hand": null,
        "/equipment_types/pouch": null,
        "/equipment_types/back": null,
    };

    constructor() {
        super();

        this.isPlayer = true;
        this.hrid = "player";
    }

    static getActiveTalismanModifierIndices(selections = [], maxActiveCount = Infinity) {
        const groupedSelections = new Map();
        selections.forEach((selection, index) => {
            if (index >= maxActiveCount) {
                return;
            }

            const modifier = talismanModifierDetailMap[selection?.modifierHrid];
            const gradeIndex = Number(selection?.gradeIndex);
            if (!modifier || !Number.isInteger(gradeIndex) || gradeIndex < 0 || gradeIndex >= modifier.gradeValues.length) {
                return;
            }

            const modifierName = modifier.keys.join("|");
            const group = groupedSelections.get(modifierName) ?? [];
            group.push({ index, gradeIndex });
            groupedSelections.set(modifierName, group);
        });

        const activeIndices = new Set();
        groupedSelections.forEach((group) => {
            group.sort((a, b) => b.gradeIndex - a.gradeIndex || a.index - b.index)
                .slice(0, 3)
                .forEach(({ index }) => activeIndices.add(index));
        });

        return activeIndices;
    }

    static createFromDTO(dto) {
        let player = new Player();

        player.staminaLevel = dto.staminaLevel;
        player.intelligenceLevel = dto.intelligenceLevel;
        player.attackLevel = dto.attackLevel;
        player.meleeLevel = dto.meleeLevel;
        player.defenseLevel = dto.defenseLevel;
        player.rangedLevel = dto.rangedLevel;
        player.magicLevel = dto.magicLevel;

        player.hrid = dto.hrid;
        player.talismanModifiers = dto.talismanModifiers ?? [];

        for (const [key, value] of Object.entries(dto.equipment)) {
            player.equipment[key] = value ? Equipment.createFromDTO(value) : null;
        }

        player.food = dto.food.map((food) => (food ? Consumable.createFromDTO(food) : null));
        player.drinks = dto.drinks.map((drink) => (drink ? Consumable.createFromDTO(drink) : null));
        player.abilities = dto.abilities.map((ability) => (ability ? Ability.createFromDTO(ability) : null));
        Object.entries(dto.houseRooms).forEach(houseRoom => {
            if (houseRoom[1] > 0) {
                player.houseRooms.push(new HouseRoom(houseRoom[0], houseRoom[1]))
            }
        });

        player.achievements = new Achievement(dto.achievements);

        player.debuffOnLevelGap = dto.debuffOnLevelGap;

        return player;
    }

    updateCombatDetails() {
        if (this.equipment["/equipment_types/main_hand"]) {
            this.combatDetails.combatStats.combatStyleHrid =
                this.equipment["/equipment_types/main_hand"].getCombatStyle();
            this.combatDetails.combatStats.damageType = this.equipment["/equipment_types/main_hand"].getDamageType();
            this.combatDetails.combatStats.attackInterval =
                this.equipment["/equipment_types/main_hand"].getCombatStat("attackInterval");
            this.combatDetails.combatStats.primaryTraining =
                this.equipment["/equipment_types/main_hand"].getPrimaryTraining();
        } else if (this.equipment["/equipment_types/two_hand"]) {
            this.combatDetails.combatStats.combatStyleHrid =
                this.equipment["/equipment_types/two_hand"].getCombatStyle();
            this.combatDetails.combatStats.damageType = this.equipment["/equipment_types/two_hand"].getDamageType();
            this.combatDetails.combatStats.attackInterval =
                this.equipment["/equipment_types/two_hand"].getCombatStat("attackInterval");
            this.combatDetails.combatStats.primaryTraining =
                this.equipment["/equipment_types/two_hand"].getPrimaryTraining();
        } else {
            this.combatDetails.combatStats.combatStyleHrid = "/combat_styles/smash";
            this.combatDetails.combatStats.damageType = "/damage_types/physical";
            this.combatDetails.combatStats.attackInterval = 3000000000;
            this.combatDetails.combatStats.primaryTraining = "/skills/melee";
        }

        if (this.equipment["/equipment_types/charm"]) {
            this.combatDetails.combatStats.focusTraining = this.equipment["/equipment_types/charm"].getFocusTraining();
        } else {
            this.combatDetails.combatStats.focusTraining = "";
        }

        const belt = this.equipment["/equipment_types/belt"];
        const beltPower = belt?.getCombatStat("talismanPower") ?? 0;
        const maxActiveTalismanModifiers = (belt?.getCombatStat("talismanSlots") ?? 0) * 4;
        const activeTalismanModifierIndices = Player.getActiveTalismanModifierIndices(
            this.talismanModifiers,
            maxActiveTalismanModifiers
        );

        Player.combatEquipmentStats.forEach((stat) => {
            const equipmentValue = Object.values(this.equipment)
                .filter((equipment) => equipment != null)
                .reduce((total, equipment) => total + equipment.getCombatStat(stat), 0);
            this.combatDetails.equipmentStats ??= {};
            this.combatDetails.talismanStats ??= {};
            this.combatDetails.equipmentStats[stat] = equipmentValue;

            const talismanValue = this.talismanModifiers.reduce((total, selection, index) => {
                if (!activeTalismanModifierIndices.has(index)) {
                    return total;
                }

                const modifier = talismanModifierDetailMap[selection.modifierHrid];
                if (!modifier || !Number.isInteger(Number(selection.gradeIndex))) {
                    return total;
                }

                const gradeValue = modifier.gradeValues[Number(selection.gradeIndex)];
                if (gradeValue === undefined) {
                    return total;
                }

                const statValue = modifier.keys
                    .filter((key) => key.charAt(0).toLowerCase() + key.slice(1) === stat)
                    .length * gradeValue * (1 + beltPower);
                return total + statValue;
            }, 0);

            this.combatDetails.talismanStats[stat] = talismanValue;
            this.combatDetails.combatStats[stat] = equipmentValue + talismanValue;
        });

        if (this.equipment["/equipment_types/pouch"]) {
            this.combatDetails.combatStats.foodSlots =
                1 + this.equipment["/equipment_types/pouch"].getCombatStat("foodSlots");
            this.combatDetails.combatStats.drinkSlots =
                1 + this.equipment["/equipment_types/pouch"].getCombatStat("drinkSlots");
        } else {
            this.combatDetails.combatStats.foodSlots = 1;
            this.combatDetails.combatStats.drinkSlots = 1;
        }

        super.updateCombatDetails();
    }
}

export default Player;
