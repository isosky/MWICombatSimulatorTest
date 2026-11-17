const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const webpack = require("webpack");
const { Heap } = require("heap-js");

globalThis.CustomEvent ??= class CustomEvent extends Event {
    constructor(type, options) {
        super(type);
        this.detail = options.detail;
    }
};

const root = path.resolve(__dirname, "..");
const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mwi-performance-tests-"));
let simulator;

before(async () => {
    const compiler = webpack({
        mode: "development",
        target: "node",
        context: root,
        entry: "./tests/performanceOptimizationExports.js",
        output: {
            path: outputDirectory,
            filename: "bundle.cjs",
            library: { type: "commonjs2" },
        },
        optimization: { minimize: false },
    });

    await new Promise((resolve, reject) => {
        compiler.run((error, stats) => {
            compiler.close((closeError) => {
                if (error || closeError || !stats || stats.hasErrors()) {
                    reject(error || closeError || new Error(stats?.toString({ all: false, errors: true })));
                } else {
                    resolve();
                }
            });
        });
    });
    simulator = require(path.join(outputDirectory, "bundle.cjs"));
});

after(() => {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
});

function createUncachedPlayer(player) {
    const reference = new simulator.Player();
    reference.equipment = { ...player.equipment };
    reference.talismanModifiers = player.talismanModifiers.map((selection) => ({ ...selection }));
    reference.combatBuffs = { ...player.combatBuffs };
    for (const stat of ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"]) {
        reference[`${stat}Level`] = player[`${stat}Level`];
    }
    return reference;
}

test("equipment and talisman caches match a fresh recalculation after input edits", () => {
    const [itemHrid, item] = Object.entries(simulator.itemDetailMap).find(([, candidate]) =>
        candidate.equipmentDetail?.type
        && Object.values(candidate.equipmentDetail.combatStats || {}).some((value) => typeof value === "number")
    );
    assert.ok(itemHrid);

    const player = new simulator.Player();
    player.equipment[item.equipmentDetail.type] = new simulator.Equipment(itemHrid, 1);
    player.updateCombatDetails();
    const firstCalculation = structuredClone(player.combatDetails);
    player.updateCombatDetails();
    assert.deepEqual(player.combatDetails, firstCalculation);

    player.equipment[item.equipmentDetail.type].enhancementLevel = 2;
    player.updateCombatDetails();
    const afterEquipmentEdit = structuredClone(player.combatDetails);
    const equipmentReference = createUncachedPlayer(player);
    equipmentReference.updateCombatDetails();
    assert.deepEqual(afterEquipmentEdit, equipmentReference.combatDetails);

    player.combatBuffs.testDamage = {
        typeHrid: "/buff_types/damage",
        ratioBoost: 0.125,
        flatBoost: 0.25,
    };
    player.updateCombatDetails();
    const buffReference = createUncachedPlayer(player);
    buffReference.updateCombatDetails();
    assert.deepEqual(player.combatDetails, buffReference.combatDetails);

    const [beltHrid, belt] = Object.entries(simulator.itemDetailMap).find(([, candidate]) =>
        candidate.equipmentDetail?.type === "/equipment_types/belt"
        && candidate.equipmentDetail.combatStats?.talismanSlots > 0
    );
    assert.ok(beltHrid);
    player.equipment[belt.equipmentDetail.type] = new simulator.Equipment(beltHrid, 1);
    player.talismanModifiers = [{ modifierHrid: "/talisman_modifiers/ability_damage", gradeIndex: 0 }];
    player.updateCombatDetails();
    const firstTalismanValue = player.combatDetails.talismanStats.abilityDamage;

    player.talismanModifiers[0].gradeIndex = 1;
    player.updateCombatDetails();
    assert.notEqual(player.combatDetails.talismanStats.abilityDamage, firstTalismanValue);
    const uncached = createUncachedPlayer(player);
    uncached.updateCombatDetails();
    assert.deepEqual(player.combatDetails, uncached.combatDetails);
});

test("fortify uses the highest active grade and refreshes up to four defense stacks", () => {
    const player = new simulator.Player();
    player.defenseLevel = 100;
    player.talismanModifiers = [
        { modifierHrid: "/talisman_modifiers/fortify", gradeIndex: 0 },
        { modifierHrid: "/talisman_modifiers/fortify", gradeIndex: 5 },
    ];
    player.updateCombatDetails();
    assert.equal(player.combatDetails.combatStats.fortify, 0);

    player.equipment["/equipment_types/belt"] = new simulator.Equipment("/items/large_talisman_belt", 0);
    player.updateCombatDetails();
    const power = player.equipment["/equipment_types/belt"].getCombatStat("talismanPower");
    const perStack = 0.04 * (1 + power);
    assert.equal(player.combatDetails.combatStats.fortify, perStack);
    const stats = ["totalArmor", "totalWaterResistance", "totalNatureResistance", "totalFireResistance"];
    const base = stats.map((stat) => player.combatDetails[stat]);
    const combat = new simulator.CombatSimulator([player], null, null);
    for (let second = 0; second <= 4; second++) {
        combat.simulationTime = second * 1e9;
        combat.applyFortifyOnHit(player);
        const stacks = Math.min(second + 1, 4);
        for (let i = 0; i < stats.length; i++) {
            assert.ok(Math.abs(player.combatDetails[stats[i]] - base[i] * (1 + perStack * stacks)) < 1e-10);
        }
    }

    for (let second = 5; second <= 9; second++) {
        combat.simulationTime = second * 1e9;
        combat.processCheckBuffExpirationEvent(combat.eventQueue.getNextEvent());
        const stacks = second < 9 ? 4 : 0;
        for (let i = 0; i < stats.length; i++) {
            assert.ok(Math.abs(player.combatDetails[stats[i]] - base[i] * (1 + perStack * stacks)) < 1e-10);
        }
    }
    combat.simulationTime = 10e9;
    combat.applyFortifyOnHit(player);
    player.clearBuffs();
    assert.equal(player.combatBuffs["/buff_uniques/fortify_armor"], undefined);
    assert.equal(player.combatDetails.totalArmor, base[0]);
});

test("fortify triggers on actual auto, ability, parry and retaliation hits, but not misses or lethal hits", () => {
    const player = new simulator.Player();
    player.hrid = "player1";
    player.equipment["/equipment_types/belt"] = new simulator.Equipment("/items/large_talisman_belt", 0);
    player.talismanModifiers = [{ modifierHrid: "/talisman_modifiers/fortify", gradeIndex: 5 }];
    player.updateCombatDetails();
    const enemy = new simulator.CombatUnit();
    enemy.hrid = "enemy";
    enemy.isPlayer = false;
    enemy.updateCombatDetails();
    const combat = new simulator.CombatSimulator([player], null, null);
    combat.enemies = [enemy];
    combat.simulationTime = 0;
    combat.checkEncounterEnd = () => true;
    combat.checkParry = () => undefined;
    const ability = { hrid: "test_ability" };
    const effect = { targetType: "enemy", pierceChance: 0 };
    const originalAttack = simulator.CombatUtilities.processAttack;
    let result = {
        didHit: false, retaliationDidHit: false, damageDone: 0, baseDamageDone: 0,
        echoDamageDone: 0, overkillDamageDone: 0, thornDamageDone: 0,
        retaliationDamageDone: 0, lifeStealHeal: 0, manaLeechMana: 0, hpDrain: 0,
    };
    simulator.CombatUtilities.processAttack = () => result;
    const stacks = () => player.combatBuffs["/buff_uniques/fortify_armor"]?.stacks || 0;
    try {
        combat.processAutoAttackEvent({ source: enemy });
        assert.equal(stacks(), 0);
        result = { ...result, didHit: true };
        combat.processAutoAttackEvent({ source: enemy });
        assert.equal(stacks(), 1);
        combat.processAbilityDamageEffect(enemy, ability, effect);
        assert.equal(stacks(), 2);
        combat.checkParry = () => enemy;
        combat.processAbilityDamageEffect(player, ability, effect);
        assert.equal(stacks(), 3);
        combat.checkParry = () => undefined;
        result = { ...result, didHit: false, retaliationDidHit: true };
        combat.processAutoAttackEvent({ source: player });
        assert.equal(stacks(), 4);
        player.clearBuffs();
        player.combatDetails.currentHitpoints = 0;
        combat.applyFortifyFromAttack(enemy, player, { didHit: true, retaliationDidHit: false });
        assert.equal(stacks(), 0);
    } finally {
        simulator.CombatUtilities.processAttack = originalAttack;
    }
});

test("fortify reduces actual hit damage and expires after death and revival or restart", () => {
    const player = new simulator.Player();
    player.hrid = "player1";
    player.defenseLevel = 100;
    player.equipment["/equipment_types/belt"] = new simulator.Equipment("/items/large_talisman_belt", 0);
    player.talismanModifiers = [{ modifierHrid: "/talisman_modifiers/fortify", gradeIndex: 5 }];
    player.updateCombatDetails();
    const enemy = new simulator.CombatUnit();
    enemy.isPlayer = false;
    enemy.hrid = "enemy";
    enemy.updateCombatDetails();
    enemy.combatDetails.smashAccuracyRating = 100000;
    enemy.combatDetails.smashMaxDamage = 1000;
    const combat = new simulator.CombatSimulator([player], null, null);
    combat.simulationTime = 0;
    const random = Math.random;
    try {
        Math.random = () => 0.5;
        player.combatDetails.currentHitpoints = 10000;
        const unprotected = simulator.CombatUtilities.processAttack(enemy, player);
        assert.ok(unprotected.didHit);
        for (let i = 0; i < 4; i++) combat.applyFortifyOnHit(player);
        player.combatDetails.currentHitpoints = 10000;
        const protectedHit = simulator.CombatUtilities.processAttack(enemy, player);
        assert.ok(protectedHit.didHit);
        assert.ok(protectedHit.damageDone < unprotected.damageDone);
    } finally {
        Math.random = random;
    }

    combat.eventQueue.clearEventsForUnit(player);
    player.combatDetails.currentHitpoints = 0;
    combat.simulationTime = 3e9;
    combat.startNewEncounter = () => {};
    combat.processCombatStartEvent({ time: 3e9 });
    assert.ok(player.combatBuffs["/buff_uniques/fortify_armor"]);
    const expiry = combat.eventQueue.getNextEvent();
    assert.equal(expiry.time, 5e9);
    combat.simulationTime = expiry.time;
    combat.processCheckBuffExpirationEvent(expiry);
    assert.equal(player.combatBuffs["/buff_uniques/fortify_armor"], undefined);

    combat.simulationTime = 10e9;
    combat.applyFortifyOnHit(player);
    combat.eventQueue.clearEventsForUnit(player);
    player.combatDetails.currentHitpoints = 0;
    combat.simulationTime = 12e9;
    combat.addNextAttackEvent = () => {};
    combat.processAbilityReviveEffect(player, { hrid: "revive" }, {
        targetType: "deadAlly", combatStyleHrid: "/combat_styles/magic", damageFlat: 10, damageRatio: 1,
    });
    assert.ok(player.combatDetails.currentHitpoints > 0);
    const revivedExpiry = combat.eventQueue.getMatching((event) => event.type === "checkBuffExpiration" && event.source === player);
    assert.equal(revivedExpiry.time, 15e9);
    combat.simulationTime = revivedExpiry.time;
    combat.processCheckBuffExpirationEvent(revivedExpiry);
    assert.equal(player.combatBuffs["/buff_uniques/fortify_armor"], undefined);
});

test("buff index preserves order and is cleared after recalculation", () => {
    const player = new simulator.Player();
    player.combatBuffs = {
        first: { typeHrid: "/buff_types/damage", ratioBoost: 0.2, flatBoost: 1 },
        second: { typeHrid: "/buff_types/damage", ratioBoost: 0.1, flatBoost: 2 },
    };
    const expected = [
        { ratioBoost: 0.2, flatBoost: 1 },
        { ratioBoost: 0.1, flatBoost: 2 },
    ];

    const recalculate = player.recalculateCombatDetails;
    player.recalculateCombatDetails = function () {
        assert.deepEqual(this.getBuffBoosts("/buff_types/damage"), expected);
    };
    player.updateCombatDetails();
    player.recalculateCombatDetails = recalculate;

    assert.equal(player._buffBoostIndex, null);
    assert.deepEqual(player.getBuffBoosts("/buff_types/damage"), expected);
});

test("event queue scans and cancellations preserve heap behavior", () => {
    const queue = new simulator.EventQueue();
    const reference = new Heap((a, b) => a.time - b.time);
    const units = [{}, {}, {}];
    let seed = 33;
    const random = (n) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return Math.floor(seed / 4294967296 * n);
    };

    for (let i = 0; i < 1000; i++) {
        const type = `type${random(4)}`;
        const source = units[random(3)];
        const action = random(8);
        if (action < 4) {
            const event = {
                id: i,
                time: random(12),
                type,
                source,
                target: units[random(3)],
                hrid: `unit${random(3)}`,
            };
            queue.addEvent(event);
            reference.push(event);
        } else if (action === 4) {
            assert.equal(queue.getNextEvent(), reference.pop());
        } else if (action === 5) {
            queue.clearEventsForUnit(source);
            for (const event of reference.toArray()) {
                if (event.source === source || event.target === source) reference.remove(event);
            }
        } else if (action === 6) {
            queue.clearEventsOfType(type);
            for (const event of reference.toArray()) {
                if (event.type === type) reference.remove(event);
            }
        } else {
            const matches = (event) => event.type === type && event.source === source;
            assert.equal(queue.getMatching(matches), reference.toArray().find(matches) || null);
            assert.equal(queue.containsEventOfType(type), reference.toArray().some((event) => event.type === type));
            assert.equal(
                queue.containsEventOfTypeAndHrid(type, "unit1"),
                reference.toArray().some((event) => event.type === type && event.hrid === "unit1")
            );
        }
        assert.deepEqual(queue.minHeap.toArray(), reference.toArray());
    }
});

test("event-loop simulations emit a final progress update", async () => {
    const combat = new simulator.CombatSimulator([], null, null);
    combat.enemies = [];
    const progress = [];
    combat.addEventListener("progress", (event) => progress.push(event.detail.progress));

    await combat.simulate(1);

    assert.deepEqual(progress, [1]);
});

test("simulation records regular-zone bosses without requiring dungeon spawn data", async () => {
    const zone = {
        isDungeon: false,
        monsterSpawnInfo: { bossSpawns: [{ combatMonsterHrid: "/monsters/boss" }] },
    };
    const combat = new simulator.CombatSimulator([], zone, null);
    combat.processEvent = () => { combat.simulationTime = 1; };
    const result = await combat.simulate(1);
    assert.deepEqual(result.bossSpawns, ["/monsters/boss"]);

    zone.monsterSpawnInfo.bossSpawns = null;
    const noBossResult = await combat.simulate(1);
    assert.deepEqual(noBossResult.bossSpawns, []);
});

test("zone boss time includes unfinished fights and does not depend on player attacks", () => {
    const hour = 3600e9;
    const result = {
        isDungeon: false,
        simulatedTime: 2 * hour,
        bossSpawns: ["boss1", "boss2", "notEncountered"],
        attacks: {},
        timeSpentAlive: [
            { name: "boss1", timeSpentAlive: 0.3 * hour, spawnedAt: 1.8 * hour, alive: true, count: 2 },
            { name: "boss2", timeSpentAlive: 0.2 * hour, spawnedAt: 0, alive: false, count: 1 },
        ],
    };
    const stats = simulator.getZoneBossTimeStats(result);
    assert.deepEqual(stats.map((item) => item.name), ["boss1", "boss2"]);
    assert.ok(Math.abs(stats[0].hours - 0.5) < 1e-10);
    assert.ok(Math.abs(stats[0].percentage - 25) < 1e-10);
    assert.equal(stats[1].hours, 0.2);
    assert.equal(stats[1].percentage, 10);
    assert.deepEqual(simulator.getZoneBossTimeStats({ ...result, isDungeon: true }), []);
});

test("personal buffs stay assigned to character HRIDs when a later character is selected alone", () => {
    const playerOneBuff = { uniqueHrid: "playerOneBuff" };
    const playerTwoBuff = { uniqueHrid: "playerTwoBuff" };

    const mappedBuffs = simulator.mapPersonalBuffsByPlayer(
        {
            player1: ["/items/seal_of_attack_speed"],
            player2: ["/items/seal_of_damage"],
        },
        {
            "/items/seal_of_attack_speed": playerOneBuff,
            "/items/seal_of_damage": playerTwoBuff,
        }
    );

    assert.deepEqual(mappedBuffs, {
        player1: [playerOneBuff],
        player2: [playerTwoBuff],
    });
    assert.deepEqual(simulator.getPersonalBuffsForPlayer(mappedBuffs, "player2"), [playerTwoBuff]);
    assert.deepEqual(simulator.getPersonalBuffsForPlayer(mappedBuffs, "player3"), []);
});

test("consumable presets read the plugin's ten groups and migrate its legacy groups", () => {
    const stored = {
        mwicFoodConfigV7: JSON.stringify({
            food: { "10": { foods: ["/items/apple_yogurt"], drinks: ["/items/attack_coffee"] } },
            panelState: { isOpen: true },
        }),
    };
    const storage = { getItem: (key) => stored[key] ?? null };
    const presets = simulator.readConsumablePresetStorage(storage);
    assert.deepEqual(presets.food["10"], {
        foods: ["/items/apple_yogurt", "", ""],
        drinks: ["/items/attack_coffee", "", ""],
    });
    assert.equal(presets.panelState.isOpen, true);
    assert.equal(Object.keys(presets.food).length, 10);

    delete stored.mwicFoodConfigV7;
    stored.mwicConfigV6 = JSON.stringify({ food: { A: { foods: ["/items/apple_yogurt"] } } });
    assert.equal(simulator.readConsumablePresetStorage(storage).food["1"].foods[0], "/items/apple_yogurt");
    stored.mwicFoodConfigV7 = "{";
    assert.throws(() => simulator.readConsumablePresetStorage(storage), SyntaxError);
});

test("applying a consumable preset preserves each player's other settings and existing triggers", () => {
    const existingTriggers = [{ condition: "custom" }];
    const playerData = {
        player: { attackLevel: 42 },
        food: { "/action_types/combat": [{ itemHrid: "/items/old" }], other: "preserved" },
        drinks: { "/action_types/combat": [] },
        triggerMap: { "/items/apple_yogurt": existingTriggers },
    };
    const preset = { foods: ["/items/apple_yogurt"], drinks: ["/items/attack_coffee"] };
    const itemMap = {
        "/items/attack_coffee": { consumableDetail: { defaultCombatTriggers: [{ condition: "default" }] } },
    };
    const updated = simulator.applyConsumablePresetToPlayer(playerData, preset, itemMap);
    assert.deepEqual(updated.food["/action_types/combat"], [
        { itemHrid: "/items/apple_yogurt" }, { itemHrid: "" }, { itemHrid: "" },
    ]);
    assert.equal(updated.food.other, "preserved");
    assert.equal(updated.player.attackLevel, 42);
    assert.deepEqual(updated.triggerMap["/items/apple_yogurt"], existingTriggers);
    assert.deepEqual(updated.triggerMap["/items/attack_coffee"], [{ condition: "default" }]);
    assert.equal(playerData.food["/action_types/combat"][0].itemHrid, "/items/old");
    assert.throws(() => simulator.applyConsumablePresetToPlayer(playerData, preset, {}), /Unknown consumable/);
});

test("talisman combinations respect fixed specials, three-of-a-kind and belt slots", () => {
    const combos = [...simulator.generateTalismanCombinations(["a", "b", "c"], ["x", "y"], 8, 3, 5)];
    assert.equal(simulator.countTalismanCombinations(3, 2, 8), 3);
    assert.equal(combos.length, 3);
    assert.deepEqual(combos[0], [
        { modifierHrid: "x", gradeIndex: 5 }, { modifierHrid: "y", gradeIndex: 5 },
        ...["a", "a", "a", "b", "b", "b"].map((modifierHrid) => ({ modifierHrid, gradeIndex: 3 })),
    ]);
    assert.equal(simulator.countTalismanCombinations(3, 1, 8), 3);
    assert.equal(simulator.countTalismanCombinations(1, 0, 0), 1);
    assert.equal([...simulator.generateTalismanCombinations([], [], 0, 0, 0)].length, 1);
    const groups = ["threat", "threat", "other"];
    assert.equal(simulator.countTalismanCombinations(3, 2, 8, groups), 2);
    assert.equal([...simulator.generateTalismanCombinations(["a", "b", "c"], ["x", "y"], 8, 3, 5, groups)].length, 2);
});

test("talisman combinations try each unused candidate for a single-type remainder", () => {
    const ordinary = ["a", "b", "c", "alias", "d"];
    const groups = ["a", "b", "c", "a", "d"];
    for (const specialCount of [2, 4]) {
        const special = Array.from({ length: specialCount }, (_, index) => `special${index}`);
        const combinations = [...simulator.generateTalismanCombinations(ordinary, special, 12, 2, 5, groups)];
        assert.equal(simulator.countTalismanCombinations(5, specialCount, 12, groups), combinations.length);
        assert.equal(combinations.length, specialCount === 4 ? 21 : 8);
        const remainder = (12 - specialCount) % 3;
        const fillers = new Set();
        for (const combination of combinations) {
            assert.equal(combination.length, 12);
            assert.deepEqual(combination.slice(0, specialCount).map((entry) => entry.modifierHrid), special);
            const filler = combination.at(-1).modifierHrid;
            fillers.add(filler);
            assert.ok(combination.slice(-remainder).every((entry) => entry.modifierHrid === filler && entry.gradeIndex === 2));
            const fillerGroup = groups[ordinary.indexOf(filler)];
            assert.ok(combination.slice(specialCount, -remainder)
                .every((entry) => groups[ordinary.indexOf(entry.modifierHrid)] !== fillerGroup));
        }
        assert.deepEqual(fillers, new Set(ordinary));
        assert.equal(new Set(combinations.map(JSON.stringify)).size, combinations.length);
    }
    assert.equal(simulator.countTalismanCombinations(4, 4, 12), 12);
    assert.equal(simulator.countTalismanCombinations(3, 4, 12, ["a", "a", "b"]), 0);
    assert.equal([...simulator.generateTalismanCombinations(["a", "alias", "b"], ["w", "x", "y", "z"], 12, 2, 5, ["a", "a", "b"])].length, 0);
    assert.equal(simulator.countTalismanCombinations(3, 0, 2), 3);
    assert.equal(simulator.countTalismanCombinations(1, 13, 12, ["a"]), 0);
});

test("talisman pool tries selected specials individually, together and not at all", () => {
    const ordinary = ["a", "b", "c", "d"];
    const special = ["x", "y"];
    const combinations = [...simulator.generateTalismanPoolCombinations(ordinary, special, 12, 2, 5)];
    assert.equal(simulator.countTalismanPoolCombinations(4, 2, 12), 13);
    assert.equal(combinations.length, 13);
    const subsets = combinations.map((combination) =>
        combination.filter((selection) => special.includes(selection.modifierHrid)).map((selection) => selection.modifierHrid)
    );
    assert.deepEqual(subsets[0], ["x", "y"]);
    assert.deepEqual(new Set(subsets.map((subset) => subset.join(","))), new Set(["x,y", "x", "y", ""]));
    assert.ok(combinations.every((combination) => combination.length === 12));
    assert.ok(combinations.flat().filter((selection) => special.includes(selection.modifierHrid))
        .every((selection) => selection.gradeIndex === 5));
    assert.equal(simulator.countTalismanPoolCombinations(4, 4, 12), 69);
    assert.equal(simulator.countTalismanPoolCombinations(4, 0, 12), 1);
    assert.equal(simulator.countTalismanPoolCombinations(0, 2, 1), 2);
    const aliases = ["a", "a", "b", "c", "d"];
    const withAliases = [...simulator.generateTalismanPoolCombinations(["a", "alias", "b", "c", "d"], special, 12, 2, 5, aliases)];
    assert.equal(simulator.countTalismanPoolCombinations(5, 2, 12, aliases), withAliases.length);
});

test("talisman pool presets persist, overwrite and delete without discarding malformed storage", () => {
    const data = new Map();
    const storage = {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => data.set(key, value),
    };
    const key = simulator.CANDIDATE_PRESETS_KEY;
    simulator.writeNamedPoolPreset(storage, key, { name: "test", ordinary: ["a"] });
    simulator.writeNamedPoolPreset(storage, key, { name: "test", ordinary: ["b"] });
    simulator.writeNamedPoolPreset(storage, key, { name: "other", ordinary: [] });
    assert.deepEqual(simulator.readNamedPoolPresets(storage, key).map((preset) => preset.ordinary), [["b"], []]);
    simulator.deleteNamedPoolPreset(storage, key, "test");
    assert.deepEqual(simulator.readNamedPoolPresets(storage, key).map((preset) => preset.name), ["other"]);
    data.set(key, "{bad json");
    assert.throws(() => simulator.writeNamedPoolPreset(storage, key, { name: "new" }));
    assert.equal(data.get(key), "{bad json");
});

test("talisman pool preset validation rejects unavailable entries, invalid grades and duplicate slots", () => {
    const ordinary = new Set(["a", "b"]);
    const special = new Set(["x"]);
    const candidate = { ordinary: ["a", "b"], special: ["x"], ordinaryGrade: 2, specialGrade: 5 };
    assert.doesNotThrow(() => simulator.validateCandidatePreset(candidate, ordinary, special));
    assert.throws(() => simulator.validateCandidatePreset({ ...candidate, ordinary: ["a", "a"] }, ordinary, special));
    assert.throws(() => simulator.validateCandidatePreset({ ...candidate, special: ["unknown"] }, ordinary, special));
    assert.throws(() => simulator.validateCandidatePreset({ ...candidate, ordinaryGrade: 6 }, ordinary, special));
    assert.doesNotThrow(() => simulator.validateCandidatePreset({ ...candidate, filler: "a" }, ordinary, special));
    assert.doesNotThrow(() => simulator.validateCandidatePreset({ ...candidate, filler: "unknown" }, ordinary, special));

    const players = [1, 3, 5].map((id) => ({
        hrid: `player${id}`, selections: [{ modifierHrid: "a", gradeIndex: 2 }],
    }));
    assert.doesNotThrow(() => simulator.validateTeamPreset({ players }, ordinary));
    assert.throws(() => simulator.validateTeamPreset({ players: [players[0], players[0], players[2]] }, ordinary));
    assert.throws(() => simulator.validateTeamPreset({
        players: [players[0], players[1], { ...players[2], selections: [{ modifierHrid: "missing", gradeIndex: 0 }] }],
    }, ordinary));
    assert.throws(() => simulator.validateTeamPreset({
        players: [players[0], players[1], { ...players[2], selections: [{ modifierHrid: "a", gradeIndex: -1 }] }],
    }, ordinary));
});

test("leaderboard ranks each player against their own empty baseline with current teammates", async () => {
    const players = ["old0", "old1", "old2"].map((modifierHrid) => ({
        talismanModifiers: [{ modifierHrid, gradeIndex: 1 }],
    }));
    const candidates = [
        { ordinary: ["a"], special: ["s"], slots: 3, ordinaryGrade: 2, specialGrade: 5 },
        { ordinary: [], special: ["t"], slots: 1, ordinaryGrade: 2, specialGrade: 4 },
        { ordinary: ["b"], special: [], slots: 3, ordinaryGrade: 1, specialGrade: 5 },
    ];
    const weights = { old0: 10, old1: 20, old2: 30, a: 4, s: 7, t: 9, b: 2 };
    const received = [];
    const seenTeams = new Map();
    const baselines = new Map();
    const updates = [];
    const progress = [];
    let active = 0;
    let peak = 0;
    const leaderboard = simulator.createTalismanLeaderboard({
        players, candidateSets: candidates, repeats: 2, threads: 3,
        message: { simulationTimeLimit: 4 * 3600e9 },
        createWorker: () => ({
            postMessage(message) {
                received.push(message);
                active++;
                peak = Math.max(peak, active);
                const score = 50 + message.players.flatMap((player) => player.talismanModifiers)
                    .reduce((sum, entry) => sum + weights[entry.modifierHrid], 0);
                const key = JSON.stringify(message.players.map((player) => player.talismanModifiers));
                const runNumber = seenTeams.get(key) || 0;
                seenTeams.set(key, runNumber + 1);
                setImmediate(() => {
                    active--;
                    this.onmessage({ data: {
                        type: "simulation_result", simResult: { simulatedTime: 3600e9, encounters: score + 2 * (runNumber % 2) },
                    } });
                });
            },
            terminate() {},
        }),
        onBaseline: (record) => { if (record.completed === 2) baselines.set(record.playerIndex, record.eph); },
        onResult: (record) => updates.push(record),
        onProgress: (record) => progress.push(record),
    });
    const results = await leaderboard.run();
    assert.equal(baselines.get(0), 101);
    assert.equal(baselines.get(1), 91);
    assert.equal(baselines.get(2), 81);
    assert.equal(received.length, 14);
    assert.equal(peak, 3);
    assert.ok(received.every((message) => message.simulationTimeLimit === 4 * 3600e9));
    assert.deepEqual(progress.at(-1), { completed: 14, total: 14 });
    for (const result of results) {
        const weight = weights[result.candidate.modifierHrid];
        assert.equal(result.delta, weight * result.candidate.count);
    }
    assert.equal(updates.filter((record) => record.completed === 2).length, 4);
    const aRun = received.find((message) => message.players[0].talismanModifiers[0]?.modifierHrid === "a");
    assert.deepEqual(aRun.players.map((player) => player.talismanModifiers), [
        Array.from({ length: 3 }, () => ({ modifierHrid: "a", gradeIndex: 2 })),
        [{ modifierHrid: "old1", gradeIndex: 1 }], [{ modifierHrid: "old2", gradeIndex: 1 }],
    ]);
    const specialRun = received.find((message) => message.players[0].talismanModifiers[0]?.modifierHrid === "s");
    assert.deepEqual(specialRun.players[0].talismanModifiers, [{ modifierHrid: "s", gradeIndex: 5 }]);
    assert.deepEqual(players.map((player) => player.talismanModifiers[0].modifierHrid), ["old0", "old1", "old2"]);
});

test("leaderboard rejects insufficient slots and stops pending workers", async () => {
    const options = {
        players: [{ talismanModifiers: [] }],
        candidateSets: [{ ordinary: ["a"], special: [], slots: 2, ordinaryGrade: 2, specialGrade: 5 }],
        repeats: 2, threads: 2, message: {},
        createWorker: () => ({ postMessage() {}, terminate() {} }),
        onBaseline: () => {}, onResult: () => {}, onProgress: () => {},
    };
    assert.throws(() => simulator.createTalismanLeaderboard(options), /insufficient talisman slots/);
    let terminated = 0;
    options.candidateSets[0].slots = 3;
    options.createWorker = () => ({ postMessage() {}, terminate() { terminated++; } });
    const leaderboard = simulator.createTalismanLeaderboard(options);
    const run = leaderboard.run();
    leaderboard.stop();
    await assert.rejects(run, /Simulation stopped/);
    assert.equal(terminated, 2);
});

test("talisman optimizer screens once and independently reviews only the top five", async () => {
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const durations = [];
    const updates = [];
    let reviewing = false;
    const reviewCounts = new Map();
    const option = (modifierHrid) => [{ modifierHrid, gradeIndex: 0 }];
    const sets = ["a", "b", "c"].map((name) => ({
        count: 2,
        create: function* () { yield option(`${name}0`); yield option(`${name}1`); },
    }));
    const createWorker = () => ({
        postMessage(message) {
            durations.push(message.simulationTimeLimit);
            active++;
            maximumActive = Math.max(maximumActive, active);
            calls++;
            let score = message.players.reduce((sum, player) =>
                sum + Number(player.talismanModifiers[0].modifierHrid.endsWith("1")), 1);
            const key = JSON.stringify(message.players.map((player) => player.talismanModifiers));
            if (reviewing && message.players[0].talismanModifiers[0].modifierHrid === "a0") {
                const count = reviewCounts.get(key) || 0;
                reviewCounts.set(key, count + 1);
                score += 10 + count % 3 - 1;
            }
            setImmediate(() => {
                active--;
                this.onmessage({ data: { type: "simulation_result", simResult: {
                    simulatedTime: 3600e9, encounters: score,
                } } });
            });
        },
        terminate() {},
    });
    const optimizer = simulator.createTalismanOptimizer({
        players: [{}, {}, {}], candidateSets: sets, repeats: 3, threads: 2,
        message: { type: "start_simulation", simulationTimeLimit: 24 * 3600e9 }, createWorker,
        onResult: (result) => updates.push(result), onProgress: () => {},
        onReviewStart: () => { reviewing = true; },
    });
    const best = await optimizer.run();
    assert.equal(best.eph, 13);
    assert.deepEqual(best.team.map((candidate) => candidate[0].modifierHrid), ["a0", "b1", "c1"]);
    assert.equal(calls, 21);
    assert.ok(durations.every((duration) => duration === 24 * 3600e9));
    assert.equal(maximumActive, 2);
    const screened = updates.filter((result) => result.phase === "screen");
    const reviewed = updates.filter((result) => result.phase === "review" && result.completed === 3);
    assert.equal(screened.length, 6);
    assert.equal(reviewed.length, 5);
    assert.ok(screened.every((result) => result.completed === 1 && result.repeats === 1));
    assert.deepEqual(new Set(reviewed.map((result) => result.key)),
        new Set([...screened].sort((a, b) => b.eph - a.eph).slice(0, 5).map((result) => result.key)));
});

test("ranking keeps the top five and preserves feasible optional-special combinations", () => {
    const ordinary = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const scores = ordinary.map((modifierHrid, index) => ({ candidate: { modifierHrid }, delta: 8 - index }));
    const set = { ordinary, groupKeys: ordinary, special: ["s1", "s2", "s3", "s4"], slots: 12 };
    const top = simulator.selectRankedCandidates(set, scores);
    assert.deepEqual(top, ["a", "b", "c", "d", "e"]);
    assert.equal(simulator.countTalismanPoolCombinations(5, 4, 12), 275);
    const combinations = [...simulator.generateTalismanPoolCombinations(top, set.special, 12, 2, 5)];
    assert.ok(combinations.some((combination) => !combination.some((entry) => set.special.includes(entry.modifierHrid))));
    assert.ok(combinations.some((combination) => {
        const counts = combination.reduce((map, entry) =>
            map.set(entry.modifierHrid, (map.get(entry.modifierHrid) || 0) + 1), new Map());
        return [...counts].filter(([hrid]) => set.special.includes(hrid)).length === 1
            && [...counts.values()].filter((count) => count === 3).length === 3
            && [...counts.values()].filter((count) => count === 2).length === 1;
    }));
    assert.throws(() => simulator.selectRankedCandidates(set, scores.slice(1)), /Incomplete/);
    const aliases = { ...set, groupKeys: ["x", "x", "x", "x", "x", "y", "z", "w"] };
    const retained = simulator.selectRankedCandidates(aliases, scores);
    assert.ok(retained.includes("f") && retained.includes("g") && retained.includes("h"));
    const keys = aliases.groupKeys.filter((_, index) => retained.includes(ordinary[index]));
    assert.ok(simulator.countTalismanCombinations(keys.length, 0, 12, keys), "all feasible special sizes remain feasible");
});

test("adaptive optimization ranks once, screens optional specials, and reviews the top five", async () => {
    const ordinary = Array.from({ length: 9 }, (_, index) => `o${index}`);
    const special = ["s0", "s1", "s2", "s3"];
    const set = { ordinary, special, groupKeys: ordinary, slots: 12, ordinaryGrade: 2, specialGrade: 5 };
    set.count = simulator.countTalismanPoolCombinations(9, 4, 12);
    set.create = () => simulator.generateTalismanPoolCombinations(ordinary, special, 12, 2, 5);
    const fixed = { count: 1, ordinary: [], special: [], slots: 0, create: function* () { yield []; } };
    const players = ["old0", "old1", "old2"].map((modifierHrid) => ({
        talismanModifiers: [{ modifierHrid, gradeIndex: 0 }],
    }));
    let active = 0;
    let maximumActive = 0;
    let phase = "ranking";
    let reviews = 0;
    const retainedByPlayer = new Map();
    const screenKeys = new Set();
    const screenedTeams = [];
    const rankingMessages = [];
    const durations = { ranking: [], screen: [], review: [] };
    const optimizer = simulator.createTalismanOptimizer({
        players, candidateSets: [set, fixed, fixed], repeats: 2, threads: 5,
        message: { simulationTimeLimit: 24 * 3600e9 },
        fastMode: true,
        createWorker: () => ({
            postMessage(message) {
                active++;
                maximumActive = Math.max(maximumActive, active);
                durations[phase].push(message.simulationTimeLimit);
                if (phase === "ranking") rankingMessages.push(message);
                const modifiers = message.players[0].talismanModifiers;
                const score = 100 + modifiers.reduce((sum, entry) =>
                    sum + (entry.modifierHrid.startsWith("o") ? Number(entry.modifierHrid.slice(1)) * 10 : 0), 0);
                setImmediate(() => {
                    active--;
                    this.onmessage({ data: { type: "simulation_result", simResult: {
                        simulatedTime: 3600e9, encounters: score,
                    } } });
                });
            },
            terminate() {},
        }),
        onResult: (record) => {
            if (record.phase === "screen") {
                assert.ok(!screenKeys.has(record.key), "each team is screened only once");
                screenKeys.add(record.key);
                screenedTeams.push(record.team);
            } else if (record.completed === 2) {
                reviews++;
            }
        },
        onProgress: () => {},
        onPruned: (result) => {
            retainedByPlayer.set(result.playerIndex, result.retained);
            phase = "screen";
        },
        onReviewStart: () => { phase = "review"; },
    });
    await optimizer.run();
    const retained = retainedByPlayer.get(0);
    assert.deepEqual(retained, ["o8", "o7", "o6", "o5", "o4"]);
    assert.deepEqual(retainedByPlayer.get(1), []);
    assert.equal(rankingMessages.length, 20);
    assert.ok(rankingMessages.every((message) =>
        message.players[1].talismanModifiers[0].modifierHrid === "old1"
        && message.players[2].talismanModifiers[0].modifierHrid === "old2"));
    assert.ok(screenedTeams.every((team) => team[0].every((entry) =>
        !ordinary.includes(entry.modifierHrid) || retained.includes(entry.modifierHrid))));
    assert.equal(screenKeys.size, 275);
    assert.ok(screenedTeams.some((team) => !team[0].some((entry) => special.includes(entry.modifierHrid))));
    assert.ok(screenedTeams.some((team) => team[0].filter((entry) => special.includes(entry.modifierHrid)).length === 1
        && Object.values(team[0].reduce((counts, entry) => {
            counts[entry.modifierHrid] = (counts[entry.modifierHrid] || 0) + 1;
            return counts;
        }, {})).includes(2)));
    assert.equal(maximumActive, 5);
    assert.equal(reviews, 5);
    assert.ok(durations.ranking.every((duration) => duration === 24 * 3600e9));
    assert.ok(durations.screen.every((duration) => duration === 6 * 3600e9));
    assert.ok(durations.review.every((duration) => duration === 24 * 3600e9));
});

test("adaptive ranking selects each player's own top five from the original team", async () => {
    const players = Array.from({ length: 3 }, (_, index) => ({
        talismanModifiers: [{ modifierHrid: `old${index}`, gradeIndex: 0 }],
    }));
    const sets = players.map((_, playerIndex) => {
        const ordinary = Array.from({ length: 6 }, (_, index) => `p${playerIndex}o${index}`);
        return {
            ordinary, special: [], groupKeys: ordinary, slots: 12, ordinaryGrade: 2, specialGrade: 5,
            count: simulator.countTalismanPoolCombinations(6, 0, 12),
            create: () => simulator.generateTalismanPoolCombinations(ordinary, [], 12, 2, 5),
        };
    });
    const selected = new Map();
    const rankingMessages = [];
    let ranking = true;
    const optimizer = simulator.createTalismanOptimizer({
        players, candidateSets: sets, repeats: 1, threads: 3, message: {}, fastMode: true,
        createWorker: () => ({
            postMessage(message) {
                if (ranking) rankingMessages.push(message);
                const candidate = message.players.flatMap((player) => player.talismanModifiers)
                    .find((entry) => /^p\d+o\d+$/.test(entry.modifierHrid));
                const index = candidate ? Number(candidate.modifierHrid.slice(-1)) : 0;
                const owner = candidate ? Number(candidate.modifierHrid[1]) : 0;
                const score = ranking && candidate ? 100 + (owner === 1 ? 5 - index : index) : 100;
                setImmediate(() => this.onmessage({ data: {
                    type: "simulation_result", simResult: { simulatedTime: 3600e9, encounters: score },
                } }));
            },
            terminate() {},
        }),
        onResult: () => {}, onProgress: () => {},
        onPruned: (result) => { selected.set(result.playerIndex, result.retained); ranking = false; },
    });
    await optimizer.run();
    assert.equal(rankingMessages.length, 21);
    for (const message of rankingMessages) {
        const changed = message.players.filter((player, index) =>
            player.talismanModifiers[0]?.modifierHrid !== `old${index}`);
        assert.equal(changed.length, 1, "ranking changes only the tested player");
    }
    assert.deepEqual(selected.get(0), ["p0o5", "p0o4", "p0o3", "p0o2", "p0o1"]);
    assert.deepEqual(selected.get(1), ["p1o0", "p1o1", "p1o2", "p1o3", "p1o4"]);
    assert.deepEqual(selected.get(2), ["p2o5", "p2o4", "p2o3", "p2o2", "p2o1"]);
});

test("stopping during adaptive ranking terminates the worker pool", async () => {
    const ordinary = Array.from({ length: 8 }, (_, index) => `o${index}`);
    const special = ["s0", "s1", "s2", "s3"];
    const set = { ordinary, special, groupKeys: ordinary, slots: 12, ordinaryGrade: 2, specialGrade: 5 };
    set.count = simulator.countTalismanPoolCombinations(8, 4, 12);
    set.create = () => simulator.generateTalismanPoolCombinations(ordinary, special, 12, 2, 5);
    let terminated = 0;
    let optimizer;
    optimizer = simulator.createTalismanOptimizer({
        players: [{ talismanModifiers: [] }, { talismanModifiers: [] }, { talismanModifiers: [] }],
        candidateSets: [set, set, set], repeats: 1, threads: 3,
        message: {}, fastMode: true,
        createWorker: () => ({
            postMessage() {
                setImmediate(() => this.onmessage({ data: {
                    type: "simulation_result", simResult: { simulatedTime: 3600e9, encounters: 1 },
                } }));
            },
            terminate() { terminated++; },
        }),
        onResult: () => {}, onProgress: () => {},
        onRankingProgress: ({ completed }) => { if (completed === 1) optimizer.stop(); },
    });
    await assert.rejects(optimizer.run(), /Simulation stopped/);
    assert.equal(terminated, 3);
});

test("talisman review handles fewer than five screened teams", async () => {
    let calls = 0;
    let finalists = 0;
    const optimizer = simulator.createTalismanOptimizer({
        players: [{}, {}, {}],
        candidateSets: Array.from({ length: 3 }, () => ({ count: 1, create: function* () { yield []; } })),
        repeats: 2, threads: 2, message: {},
        createWorker: () => ({
            postMessage() {
                calls++;
                setImmediate(() => this.onmessage({ data: {
                    type: "simulation_result", simResult: { simulatedTime: 3600e9, encounters: 1 },
                } }));
            },
            terminate() {},
        }),
        onResult: () => {}, onProgress: () => {},
        onReviewStart: ({ total }) => { finalists = total; },
    });
    const best = await optimizer.run();
    assert.equal(finalists, 1);
    assert.equal(calls, 3);
    assert.equal(best.phase, "review");
    assert.equal(best.completed, 2);
});

test("stopping talisman optimization terminates workers and rejects unfinished runs", async () => {
    let terminated = 0;
    const optimizer = simulator.createTalismanOptimizer({
        players: [{}, {}, {}],
        candidateSets: Array.from({ length: 3 }, () => ({ count: 1, create: function* () { yield []; } })),
        repeats: 5,
        threads: 2,
        message: { type: "start_simulation" },
        createWorker: () => ({ postMessage() {}, terminate() { terminated++; } }),
        onResult: () => {}, onProgress: () => {},
    });
    const run = optimizer.run();
    optimizer.stop();
    await assert.rejects(run, /Simulation stopped/);
    assert.equal(terminated, 2);
});

test("EPH uses completed dungeon time or encounter time like the main simulator", () => {
    assert.equal(simulator.calculateSimulationEph({
        isDungeon: true, dungeonsCompleted: 3, lastDungeonFinishTime: 3 * 3600e9, simulatedTime: 5 * 3600e9,
    }), 1);
    assert.equal(simulator.calculateSimulationEph({
        encounters: 8, lastEncounterFinishTime: 4 * 3600e9, simulatedTime: 5 * 3600e9,
    }), 2);
});

test("drop archive categories identify key fragments and charms by item HRID", () => {
    assert.equal(simulator.classifyDropCategory("/items/blue_key_fragment"), "fragments");
    assert.equal(simulator.classifyDropCategory("/items/advanced_attack_charm"), "charms");
    assert.equal(simulator.classifyDropCategory("/items/golem_essence"), "resources");
});

test("saved results group by map and difficulty and sort newest first", () => {
    const groups = simulator.groupArchiveRecords([
        { id: "older", savedAt: 10, mapHrid: "/actions/combat/fly", mapName: "Fly", difficulty: "T0" },
        { id: "hard", savedAt: 15, mapHrid: "/actions/combat/fly", mapName: "Fly", difficulty: "T1" },
        { id: "newer", savedAt: 20, mapHrid: "/actions/combat/fly", mapName: "Fly", difficulty: "T0" },
    ]);

    assert.equal(groups.length, 2);
    assert.deepEqual(groups.find((group) => group.difficulty === "T0").records.map((record) => record.id), ["newer", "older"]);
});

test("daily result quantities normalize to 24 hours and comparison changes get directional colors", () => {
    assert.equal(simulator.normalizeTo24Hours(5, 12), 10);
    assert.equal(simulator.normalizeTo24Hours(5, 24), 5);
    assert.equal(simulator.normalizeTo24Hours(5, 0), 0);
    assert.equal(simulator.comparisonTone(2, 3), "text-success");
    assert.equal(simulator.comparisonTone(3, 2), "text-danger");
    assert.equal(simulator.comparisonTone(3, 3), "");
});

test("consumable hourly quantities display with two decimal places", () => {
    assert.equal(simulator.formatHourlyQuantity(51.45833), "51.46");
    assert.equal(simulator.formatHourlyQuantity(2), "2.00");
});

test("death values round and display with two decimal places", () => {
    assert.equal(simulator.roundToTwoDecimals(0.9999999), 1);
    assert.equal(simulator.roundToTwoDecimals(2.345), 2.35);
    assert.equal(simulator.formatTwoDecimalQuantity(0.9999999), "1.00");
    assert.equal(simulator.formatTwoDecimalQuantity(638.9999), "639.00");
    assert.equal(simulator.formatTwoDecimalQuantity(0), "0.00");
});

test("saved result values round to two decimals without modifying the export configuration", () => {
    const configuration = { groupJson: "{\"1\":\"{\\\"level\\\":1.2345}\"}", simulationHours: 1.2345 };
    const result = simulator.roundSavedResultValues({
        metrics: { eph: 0.7264433, deathsPerDay: 1.2345, deathsPerHour: 0.051234, shardsPerDay: 3.4567 },
        players: [{
            name: "Player 1",
            deathsPerDay: 1.2345,
            deathsPerHour: 0.051234,
            shardsPerDay: 3.4567,
            experience: [{ name: "Attack", value: 114819.9234 }],
            consumables: [{ name: "Food", perHour: 26.6249, quantity: 638.9999 }],
        }],
        matchedDrops: [{ name: "Fragment", quantity: 3.4567 }],
        configuration,
    });
    assert.deepEqual(result.metrics, { eph: 0.73, deathsPerDay: 1.23, deathsPerHour: 0.05, shardsPerDay: 3.46 });
    assert.equal(result.players[0].experience[0].value, 114819.92);
    assert.deepEqual(result.players[0].consumables[0], { name: "Food", perHour: 26.62, quantity: 639 });
    assert.equal(result.players[0].shardsPerDay, 3.46);
    assert.equal(result.matchedDrops[0].quantity, 3.46);
    assert.deepEqual(result.configuration, configuration);
});

test("saved result export contains the original group configuration and names the result", () => {
    const exported = simulator.createRecordExport({
        mapName: "Pirate Base",
        difficulty: "T2",
        metrics: { eph: 0.7264432668 },
        configuration: { groupJson: "{\"1\":\"player-one\",\"2\":\"player-two\"}" },
    });

    assert.equal(exported.fileName, "Pirate Base-T2-0.73.json");
    assert.deepEqual(JSON.parse(exported.content), {
        1: "player-one",
        2: "player-two",
    });
    assert.equal(simulator.createRecordExport({ configuration: {} }), null);

    const integerMetricExport = simulator.createRecordExport({
        mapName: "Pirate Base",
        difficulty: "T2",
        metrics: { eph: 81 },
        configuration: { groupJson: "{\"1\":\"player-one\"}" },
    });
    assert.equal(integerMetricExport.fileName, "Pirate Base-T2-81.json");
});

test("archive configuration compresses and restores player and map settings", async () => {
    const player = JSON.stringify({
        player: { attackLevel: 42, equipment: [{ itemHrid: "/items/sword" }] },
        abilities: [{ abilityHrid: "/abilities/test" }],
        food: { "/action_types/combat": [{ itemHrid: "/items/apple" }] },
        name: "角色",
    });
    const configuration = {
        groupJson: JSON.stringify({ 1: player, 2: player }),
        mapSettings: {
            values: { selectZone: "/actions/combat/fly", selectDifficulty: "2" },
            toggles: { simDungeonToggle: false },
            checkboxes: { player1: true, player2: false },
        },
    };
    const compressed = await simulator.compressArchiveConfiguration(configuration);
    assert.deepEqual(await simulator.readArchiveConfiguration({ compressed }), configuration);
    assert.deepEqual(await simulator.readArchiveConfiguration({ groupJson: configuration.groupJson }), {
        groupJson: configuration.groupJson,
    });
    assert.equal(await simulator.readArchiveConfiguration({}), null);
    await assert.rejects(simulator.readArchiveConfiguration({ compressed: "invalid" }));
    const olderCompressed = await simulator.compressArchiveConfiguration({
        groupJson: configuration.groupJson,
        simulationSettings: { ...configuration.mapSettings, selectedPlayers: [1, 3] },
    });
    assert.deepEqual(await simulator.readArchiveConfiguration({ compressed: olderCompressed }), {
        groupJson: configuration.groupJson,
        mapSettings: {
            values: configuration.mapSettings.values,
            toggles: configuration.mapSettings.toggles,
            checkboxes: { player1: true, player2: false, player3: true, player4: false, player5: false },
        },
        partial: true,
    });
});

test("saved result shard summary uses the lowest per-player drop count", () => {
    assert.equal(simulator.minimumPlayerShardDropCount([5, 2, 7]), 2);
    assert.equal(simulator.minimumPlayerShardDropCount([]), 0);
});

test("comparison records expose per-player consumable usage separately from drops", () => {
    const items = simulator.getComparableItems({
        matchedDrops: [{ hrid: "/items/blue_key_fragment", name: "Blue Key Fragment", quantity: 4 }],
        players: [{
            hrid: "player2",
            name: "Player Two",
            consumables: [{ hrid: "/items/apple", name: "Apple", quantity: 24 }],
        }],
    });

    assert.deepEqual(items.map((item) => [item.key, item.category, item.quantity]), [
        ["drop:/items/blue_key_fragment", "fragments", 4],
        ["consumable:player2:/items/apple", "consumables", 24],
    ]);
});
