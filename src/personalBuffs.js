export function mapPersonalBuffsByPlayer(selections, buffDefinitions) {
    const mappedBuffs = {};
    for (const [playerHrid, buffHrids] of Object.entries(selections || {})) {
        if (!Array.isArray(buffHrids)) continue;
        const buffs = buffHrids.map((hrid) => buffDefinitions[hrid]).filter(Boolean);
        if (buffs.length) mappedBuffs[playerHrid] = buffs;
    }
    return mappedBuffs;
}

export function getPersonalBuffsForPlayer(mappedBuffs, playerHrid) {
    return mappedBuffs[playerHrid] || [];
}
