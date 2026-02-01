const url = require('url');
const storage = require('./storage');

// Map of partyId -> Set of { ws, memberId, nickname }
const partyConnections = new Map();

function setupWebSocket(wss) {
    wss.on('connection', (ws, req) => {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const partyId = params.get('partyId');
        const memberId = params.get('memberId');

        if (!partyId || !memberId) {
            ws.close(4000, 'Missing partyId or memberId');
            return;
        }

        const party = storage.get(partyId);
        if (!party) {
            ws.close(4001, 'Party not found');
            return;
        }

        const member = party.members[memberId];
        if (!member) {
            ws.close(4002, 'Member not found');
            return;
        }

        const nickname = member.nickname;

        // Register connection
        if (!partyConnections.has(partyId)) {
            partyConnections.set(partyId, new Set());
        }
        const conn = { ws, memberId, nickname };
        partyConnections.get(partyId).add(conn);

        console.log(`[WS] ${nickname} (${memberId}) connected to party ${partyId}`);

        // Send full state on connect
        sendTo(ws, { type: 'state', party });

        // Notify others
        broadcast(partyId, memberId, {
            type: 'member-joined',
            memberId,
            nickname,
        });

        ws.on('message', (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch (e) {
                return;
            }
            handleMessage(partyId, memberId, nickname, msg);
        });

        ws.on('close', () => {
            console.log(`[WS] ${nickname} (${memberId}) disconnected from party ${partyId}`);
            const conns = partyConnections.get(partyId);
            if (conns) {
                conns.delete(conn);
                if (conns.size === 0) partyConnections.delete(partyId);
            }
            broadcast(partyId, memberId, {
                type: 'member-left',
                memberId,
            });
        });

        ws.on('error', (err) => {
            console.error(`[WS] Error for ${nickname}:`, err.message);
        });
    });
}

function handleMessage(partyId, memberId, nickname, msg) {
    const party = storage.get(partyId);
    if (!party) return;

    switch (msg.type) {
        case 'progress': {
            const { bookId, cfi, fraction } = msg;
            if (!bookId) return;
            if (!party.members[memberId]) return;
            party.members[memberId].progress[bookId] = {
                cfi,
                fraction,
                updatedAt: new Date().toISOString(),
            };
            // Track book
            if (!party.books.includes(bookId)) {
                party.books.push(bookId);
            }
            storage.set(partyId, party);
            broadcast(partyId, memberId, {
                type: 'progress',
                memberId,
                nickname,
                bookId,
                cfi,
                fraction,
            });
            break;
        }

        case 'annotation': {
            const { bookId, annotation } = msg;
            if (!bookId || !annotation) return;
            const ann = {
                ...annotation,
                id: annotation.id || require('uuid').v4(),
                bookId,
                memberId,
                nickname,
                created: annotation.created || new Date().toISOString(),
                modified: new Date().toISOString(),
            };
            // Replace if same id exists, otherwise push
            const idx = party.annotations.findIndex(a => a.id === ann.id);
            if (idx >= 0) {
                party.annotations[idx] = ann;
            } else {
                party.annotations.push(ann);
            }
            // Track book
            if (!party.books.includes(bookId)) {
                party.books.push(bookId);
            }
            storage.set(partyId, party);
            broadcast(partyId, memberId, {
                type: 'annotation',
                memberId,
                nickname,
                bookId,
                annotation: ann,
            });
            break;
        }

        case 'delete-annotation': {
            const { bookId, annotationId } = msg;
            if (!annotationId) return;
            party.annotations = party.annotations.filter(a => a.id !== annotationId);
            storage.set(partyId, party);
            broadcast(partyId, memberId, {
                type: 'delete-annotation',
                bookId,
                annotationId,
            });
            break;
        }

        case 'comment': {
            const { bookId, text, cfi } = msg;
            if (!text) return;
            const comment = {
                id: require('uuid').v4(),
                bookId,
                memberId,
                nickname,
                text,
                cfi,
                created: new Date().toISOString(),
            };
            party.comments.push(comment);
            // Track book
            if (bookId && !party.books.includes(bookId)) {
                party.books.push(bookId);
            }
            storage.set(partyId, party);
            broadcast(partyId, memberId, {
                type: 'comment',
                memberId,
                nickname,
                bookId,
                comment,
            });
            break;
        }

        default:
            console.log(`[WS] Unknown message type: ${msg.type}`);
    }
}

function sendTo(ws, msg) {
    if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(JSON.stringify(msg));
    }
}

function broadcast(partyId, excludeMemberId, msg) {
    const conns = partyConnections.get(partyId);
    if (!conns) return;
    const data = JSON.stringify(msg);
    for (const conn of conns) {
        if (conn.memberId !== excludeMemberId && conn.ws.readyState === 1) {
            conn.ws.send(data);
        }
    }
}

module.exports = { setupWebSocket };
