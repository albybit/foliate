const express = require('express');
const { v4: uuidv4 } = require('uuid');
const storage = require('./storage');

const router = express.Router();

function generateInviteCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 for clarity
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    // Ensure uniqueness
    if (storage.findByInviteCode(code)) return generateInviteCode();
    return code;
}

// Create a new party
router.post('/parties', (req, res) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Party name is required' });
    }

    const party = {
        id: uuidv4(),
        name: name.trim(),
        inviteCode: generateInviteCode(),
        created: new Date().toISOString(),
        books: [],
        members: {},
        annotations: [],
        comments: [],
    };

    storage.set(party.id, party);
    storage.saveImmediate(party.id);
    res.status(201).json(party);
});

// Join a party by invite code
router.post('/parties/join', (req, res) => {
    const { inviteCode, nickname } = req.body;
    if (!inviteCode || !nickname) {
        return res.status(400).json({ error: 'inviteCode and nickname are required' });
    }

    const party = storage.findByInviteCode(inviteCode.toUpperCase().trim());
    if (!party) {
        return res.status(404).json({ error: 'Party not found' });
    }

    const memberId = uuidv4();
    party.members[memberId] = {
        nickname: nickname.trim(),
        joinedAt: new Date().toISOString(),
        progress: {},
    };

    storage.set(party.id, party);
    storage.saveImmediate(party.id);

    res.json({ partyId: party.id, memberId, party });
});

// Get party state
router.get('/parties/:id', (req, res) => {
    const party = storage.get(req.params.id);
    if (!party) {
        return res.status(404).json({ error: 'Party not found' });
    }
    res.json(party);
});

// Leave party
router.delete('/parties/:id/members/:memberId', (req, res) => {
    const party = storage.get(req.params.id);
    if (!party) {
        return res.status(404).json({ error: 'Party not found' });
    }

    if (!party.members[req.params.memberId]) {
        return res.status(404).json({ error: 'Member not found' });
    }

    delete party.members[req.params.memberId];
    storage.set(party.id, party);
    storage.saveImmediate(party.id);

    res.json({ ok: true });
});

module.exports = router;
