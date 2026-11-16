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

test("talisman optimizer screens once and independently reviews only the top five", async () => {
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
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
        message: { type: "start_simulation" }, createWorker,
        onResult: (result) => updates.push(result), onProgress: () => {},
        onReviewStart: () => { reviewing = true; },
    });
    const best = await optimizer.run();
    assert.equal(best.eph, 13);
    assert.deepEqual(best.team.map((candidate) => candidate[0].modifierHrid), ["a0", "b1", "c1"]);
    assert.equal(calls, 21);
    assert.equal(maximumActive, 2);
    const screened = updates.filter((result) => result.phase === "screen");
    const reviewed = updates.filter((result) => result.phase === "review" && result.completed === 3);
    assert.equal(screened.length, 6);
    assert.equal(reviewed.length, 5);
    assert.ok(screened.every((result) => result.completed === 1 && result.repeats === 1));
    assert.deepEqual(new Set(reviewed.map((result) => result.key)),
        new Set([...screened].sort((a, b) => b.eph - a.eph).slice(0, 5).map((result) => result.key)));
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
