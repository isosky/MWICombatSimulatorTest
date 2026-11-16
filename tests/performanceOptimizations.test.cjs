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
