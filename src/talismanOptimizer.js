import { calculateSimulationEph } from "./simulationResultTools";

export function countTalismanCombinations(ordinaryCount, specialCount, slots, groupKeys = null) {
    const remaining = slots - specialCount;
    if (!Number.isInteger(remaining) || remaining < 0) return 0;
    const remainder = remaining % 3;
    const groups = Math.floor(remaining / 3);
    if (groups > ordinaryCount) return 0;
    const alternatives = new Map();
    const keys = groupKeys ?? Array.from({ length: ordinaryCount }, (_, index) => index);
    for (const key of keys) alternatives.set(key, (alternatives.get(key) || 0) + 1);
    const counts = Array(groups + 1).fill(0);
    const withFiller = Array(groups + 1).fill(0);
    counts[0] = 1;
    for (const size of alternatives.values()) {
        for (let i = groups; i >= 0; i--) {
            // A group can supply either a full triplet or the remainder, not both.
            withFiller[i] += counts[i] * size + (i > 0 ? withFiller[i - 1] * size : 0);
            if (i > 0) counts[i] += counts[i - 1] * size;
        }
    }
    return remainder ? withFiller[groups] : counts[groups];
}

export function* generateTalismanCombinations(ordinary, special, slots, ordinaryGrade, specialGrade, groupKeys = ordinary) {
    const count = countTalismanCombinations(ordinary.length, special.length, slots, groupKeys);
    if (!count) return;
    const remaining = slots - special.length;
    const groups = Math.floor(remaining / 3);
    const remainder = remaining % 3;
    const selected = [];
    const selectedGroups = new Set();
    function* choose(start) {
        if (selected.length === groups) {
            const base = [
                ...special.map((modifierHrid) => ({ modifierHrid, gradeIndex: specialGrade })),
                ...selected.flatMap((modifierHrid) =>
                    Array.from({ length: 3 }, () => ({ modifierHrid, gradeIndex: ordinaryGrade }))
                ),
            ];
            if (!remainder) {
                yield base;
            } else {
                for (let i = 0; i < ordinary.length; i++) {
                    if (selectedGroups.has(groupKeys[i])) continue;
                    yield [
                        ...base,
                        ...Array.from({ length: remainder }, () => ({ modifierHrid: ordinary[i], gradeIndex: ordinaryGrade })),
                    ];
                }
            }
            return;
        }
        for (let i = start; i <= ordinary.length - (groups - selected.length); i++) {
            if (selectedGroups.has(groupKeys[i])) continue;
            selected.push(ordinary[i]);
            selectedGroups.add(groupKeys[i]);
            yield* choose(i + 1);
            selectedGroups.delete(groupKeys[i]);
            selected.pop();
        }
    }
    yield* choose(0);
}

export function countTalismanPoolCombinations(ordinaryCount, specialCount, slots, groupKeys = null) {
    let count = 0;
    let choices = 1;
    for (let size = 0; size <= Math.min(specialCount, slots); size++) {
        count += choices * countTalismanCombinations(ordinaryCount, size, slots, groupKeys);
        choices = choices * (specialCount - size) / (size + 1);
    }
    return count;
}

export function* generateTalismanPoolCombinations(ordinary, special, slots, ordinaryGrade, specialGrade, groupKeys = ordinary) {
    const subset = [];
    function* chooseSpecial(start, size) {
        if (subset.length === size) {
            yield* generateTalismanCombinations(ordinary, subset, slots, ordinaryGrade, specialGrade, groupKeys);
            return;
        }
        for (let i = start; i <= special.length - (size - subset.length); i++) {
            subset.push(special[i]);
            yield* chooseSpecial(i + 1, size);
            subset.pop();
        }
    }
    for (let size = Math.min(special.length, slots); size >= 0; size--) {
        yield* chooseSpecial(0, size);
    }
}

class SimulationWorkerPool {
    constructor(size, createWorker) {
        this.queue = [];
        this.workers = [];
        this.closed = false;
        try {
            for (let i = 0; i < size; i++) {
                const slot = { worker: createWorker(), task: null };
                slot.worker.onmessage = (event) => {
                    if (event.data.type === "simulation_progress") return;
                    if (!slot.task) return;
                    if (event.data.type === "simulation_result") {
                        this.finish(slot, null, event.data.simResult);
                    } else if (event.data.type === "simulation_error") {
                        this.finish(slot, new Error(String(event.data.error)));
                    }
                };
                slot.worker.onerror = (event) => this.finish(slot, new Error(event.message || "Simulation worker failed."));
                slot.worker.onmessageerror = () => this.finish(slot, new Error("Simulation worker message could not be read."));
                this.workers.push(slot);
            }
        } catch (error) {
            this.stop(error);
            throw error;
        }
    }

    run(message) {
        if (this.closed) return Promise.reject(new Error("Simulation stopped."));
        return new Promise((resolve, reject) => {
            this.queue.push({ message, resolve, reject });
            this.dispatch();
        });
    }

    dispatch() {
        for (const slot of this.workers) {
            if (this.closed || !this.queue.length) return;
            if (slot.task) continue;
            slot.task = this.queue.shift();
            try {
                slot.worker.postMessage(slot.task.message);
            } catch (error) {
                this.finish(slot, error);
            }
        }
    }

    finish(slot, error, result) {
        if (!slot.task) return;
        const task = slot.task;
        slot.task = null;
        if (error) task.reject(error);
        else task.resolve(result);
        this.dispatch();
    }

    stop(error = new Error("Simulation stopped.")) {
        if (this.closed) return;
        this.closed = true;
        for (const task of this.queue.splice(0)) task.reject(error);
        for (const slot of this.workers) {
            slot.worker.terminate();
            if (slot.task) {
                slot.task.reject(error);
                slot.task = null;
            }
        }
    }
}

export function createTalismanOptimizer({ players, candidateSets, repeats, threads, message, createWorker, onResult, onProgress, onReviewStart = () => {}, onReviewProgress = () => {} }) {
    const pool = new SimulationWorkerPool(threads, createWorker);
    const cache = new Map();
    let stopped = false;
    const keyOf = (team) => JSON.stringify(team);

    const evaluate = async (team, phase, runs) => {
        const key = keyOf(team);
        if (phase === "screen" && cache.has(key)) return cache.get(key);
        const record = { key, team, phase, completed: 0, repeats: runs, eph: 0 };
        let total = 0;
        const simPlayers = players.map((player, index) => ({ ...player, talismanModifiers: team[index] }));
        await Promise.all(Array.from({ length: runs }, async () => {
            const result = await pool.run({ ...message, players: simPlayers });
            const eph = calculateSimulationEph(result);
            if (!Number.isFinite(eph)) throw new Error("Invalid EPH returned by simulation.");
            total += eph;
            record.completed++;
            record.eph = total / record.completed;
            onResult({ ...record });
        }));
        if (phase === "screen") cache.set(key, record);
        return record;
    };

    const run = async () => {
        try {
            let team = candidateSets.map((set) => set.create().next().value);
            if (team.some((candidate) => !candidate)) throw new Error("A player has no valid talisman combinations.");
            let incumbent = await evaluate(team, "screen", 1);
            let round = 0;
            let improved;
            do {
                improved = false;
                round++;
                for (let playerIndex = 0; playerIndex < players.length; playerIndex++) {
                    const set = candidateSets[playerIndex];
                    const iterator = set.create();
                    let completed = 0;
                    let best = incumbent;
                    onProgress({ round, playerIndex, completed, total: set.count, evaluated: cache.size });
                    const runner = async () => {
                        while (!stopped) {
                            const next = iterator.next();
                            if (next.done) return;
                            const candidateTeam = team.slice();
                            candidateTeam[playerIndex] = next.value;
                            const result = await evaluate(candidateTeam, "screen", 1);
                            if (result.eph > best.eph) best = result;
                            completed++;
                            onProgress({ round, playerIndex, completed, total: set.count, evaluated: cache.size });
                        }
                    };
                    await Promise.all(Array.from({ length: Math.min(threads, set.count) }, () => runner()));
                    if (stopped) throw new Error("Simulation stopped.");
                    if (best.eph > incumbent.eph) {
                        team = best.team;
                        incumbent = best;
                        improved = true;
                    }
                }
            } while (improved && !stopped);
            const finalists = [...cache.values()].sort((a, b) => b.eph - a.eph).slice(0, 5);
            onReviewStart({ total: finalists.length });
            let nextIndex = 0;
            let completed = 0;
            const reviewed = [];
            const review = async () => {
                while (!stopped && nextIndex < finalists.length) {
                    const finalist = finalists[nextIndex++];
                    reviewed.push(await evaluate(finalist.team, "review", repeats));
                    completed++;
                    onReviewProgress({ completed, total: finalists.length });
                }
            };
            await Promise.all(Array.from({ length: Math.min(threads, finalists.length) }, () => review()));
            if (stopped) throw new Error("Simulation stopped.");
            reviewed.sort((a, b) => b.eph - a.eph);
            return reviewed[0];
        } finally {
            pool.stop();
        }
    };
    return {
        run,
        stop() {
            stopped = true;
            pool.stop();
        },
    };
}
