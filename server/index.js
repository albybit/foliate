const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const storage = require('./storage');
const routes = require('./routes');
const { setupWebSocket } = require('./ws-handler');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Load persisted party data
storage.loadAll();

const app = express();
app.use(express.json());
app.use('/api', routes);

// Health check
app.get('/', (_req, res) => {
    res.json({ status: 'ok', service: 'foliate-reading-party' });
});

const server = http.createServer(app);

// WebSocket server on /ws path
const wss = new WebSocketServer({ server, path: '/ws' });
setupWebSocket(wss);

server.listen(PORT, HOST, () => {
    console.log(`Reading Party server listening on ${HOST}:${PORT}`);
});

// Graceful shutdown - flush pending writes
process.on('SIGINT', () => {
    console.log('Shutting down...');
    storage.flushAll();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Shutting down...');
    storage.flushAll();
    process.exit(0);
});
