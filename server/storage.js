const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || './data';
const PARTIES_DIR = path.join(DATA_DIR, 'parties');
const DEBOUNCE_MS = 2000;

// Ensure directories exist
fs.mkdirSync(PARTIES_DIR, { recursive: true });

// In-memory cache of party data
const parties = new Map();
// Pending write timers
const writeTimers = new Map();

function partyPath(partyId) {
    return path.join(PARTIES_DIR, `${partyId}.json`);
}

function loadAll() {
    if (!fs.existsSync(PARTIES_DIR)) return;
    for (const file of fs.readdirSync(PARTIES_DIR)) {
        if (!file.endsWith('.json')) continue;
        try {
            const data = JSON.parse(fs.readFileSync(path.join(PARTIES_DIR, file), 'utf8'));
            parties.set(data.id, data);
        } catch (e) {
            console.error(`Failed to load ${file}:`, e.message);
        }
    }
    console.log(`Loaded ${parties.size} parties from disk`);
}

function save(partyId) {
    // Debounced write
    if (writeTimers.has(partyId)) {
        clearTimeout(writeTimers.get(partyId));
    }
    writeTimers.set(partyId, setTimeout(() => {
        writeTimers.delete(partyId);
        const party = parties.get(partyId);
        if (!party) return;
        try {
            fs.writeFileSync(partyPath(partyId), JSON.stringify(party, null, 2));
        } catch (e) {
            console.error(`Failed to save party ${partyId}:`, e.message);
        }
    }, DEBOUNCE_MS));
}

function saveImmediate(partyId) {
    if (writeTimers.has(partyId)) {
        clearTimeout(writeTimers.get(partyId));
        writeTimers.delete(partyId);
    }
    const party = parties.get(partyId);
    if (!party) return;
    try {
        fs.writeFileSync(partyPath(partyId), JSON.stringify(party, null, 2));
    } catch (e) {
        console.error(`Failed to save party ${partyId}:`, e.message);
    }
}

function get(partyId) {
    return parties.get(partyId);
}

function set(partyId, data) {
    parties.set(partyId, data);
    save(partyId);
}

function findByInviteCode(code) {
    for (const party of parties.values()) {
        if (party.inviteCode === code) return party;
    }
    return null;
}

function remove(partyId) {
    parties.delete(partyId);
    if (writeTimers.has(partyId)) {
        clearTimeout(writeTimers.get(partyId));
        writeTimers.delete(partyId);
    }
    try {
        fs.unlinkSync(partyPath(partyId));
    } catch (e) {
        // ignore
    }
}

function flushAll() {
    for (const [partyId, timer] of writeTimers) {
        clearTimeout(timer);
        writeTimers.delete(partyId);
        const party = parties.get(partyId);
        if (party) {
            try {
                fs.writeFileSync(partyPath(partyId), JSON.stringify(party, null, 2));
            } catch (e) {
                console.error(`Failed to flush party ${partyId}:`, e.message);
            }
        }
    }
}

module.exports = { loadAll, get, set, findByInviteCode, remove, save, saveImmediate, flushAll };
