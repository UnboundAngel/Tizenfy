/**
 * TizenSpotify - service.js
 * WebSocket server running on the TV (Node.js via TizenBrew serviceFile)
 * iPhone remote connects here, sends commands, we broadcast to userScript
 *
 * Zero external dependencies — implements RFC 6455 with http + crypto only.
 */

const http = require('http');
const crypto = require('crypto');

const PORT = 8765;
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Track connected clients by type
const clients = {
  script: null,        // userScript.js running in the TV webview
  remote: new Set(),   // iPhone remotes
};

// ─── Minimal WebSocket framing ───────────────────────────────────────────────

function createWSClient(socket) {
  let buffer = Buffer.alloc(0);
  let readyState = 1; // 1 = OPEN, 2 = CLOSING, 3 = CLOSED
  const handlers = { message: [], close: [], error: [] };

  function on(event, fn) {
    if (handlers[event]) handlers[event].push(fn);
  }
  function emit(event, ...args) {
    (handlers[event] || []).forEach(fn => fn(...args));
  }

  function send(data) {
    if (readyState !== 1) return;
    const payload = Buffer.from(data, 'utf8');
    const len = payload.length;
    let header;
    if (len <= 125) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text opcode
      header[1] = len;
    } else if (len <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    try { socket.write(Buffer.concat([header, payload])); } catch (_) {}
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    processFrames();
  });

  socket.on('close', () => {
    readyState = 3;
    emit('close');
  });

  socket.on('error', (err) => {
    emit('error', err);
  });

  function processFrames() {
    while (true) {
      if (buffer.length < 2) return;

      const firstByte  = buffer[0];
      const secondByte = buffer[1];
      const opcode     = firstByte & 0x0F;
      const masked     = (secondByte & 0x80) !== 0;
      let payloadLen   = secondByte & 0x7F;
      let offset       = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = buffer.readUInt32BE(6); // treat as 32-bit (< 4 GB fine here)
        offset = 10;
      }

      if (masked) {
        if (buffer.length < offset + 4) return;
        offset += 4;
      }

      if (buffer.length < offset + payloadLen) return;

      let payload = buffer.slice(offset - (masked ? 4 : 0), offset + payloadLen);
      if (masked) {
        const maskKey = buffer.slice(offset - 4, offset);
        payload = buffer.slice(offset, offset + payloadLen);
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      } else {
        payload = buffer.slice(offset, offset + payloadLen);
      }

      buffer = buffer.slice(offset + payloadLen);

      if (opcode === 0x8) {
        // Close frame
        readyState = 3;
        try {
          const frame = Buffer.from([0x88, 0x00]);
          socket.write(frame);
        } catch (_) {}
        socket.destroy();
        emit('close');
        return;
      } else if (opcode === 0x9) {
        // Ping → Pong
        const pong = Buffer.alloc(2 + payload.length);
        pong[0] = 0x8A;
        pong[1] = payload.length;
        payload.copy(pong, 2);
        try { socket.write(pong); } catch (_) {}
      } else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        // Text / binary / continuation
        emit('message', payload.toString('utf8'));
      }
    }
  }

  return {
    send,
    on,
    get readyState() { return readyState; },
  };
}

// ─── HTTP server (upgrade → WebSocket) ───────────────────────────────────────

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('TizenSpotify WebSocket server running');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key + WS_MAGIC)
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );

  const ws = createWSClient(socket);
  console.log('[TizenSpotify] New connection from', socket.remoteAddress);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch (e) { console.log('[TizenSpotify] Bad message:', raw); return; }

    console.log('[TizenSpotify] Message:', msg);

    // Registration — client identifies itself on connect
    if (msg.type === 'register') {
      if (msg.role === 'script') {
        clients.script = ws;
        console.log('[TizenSpotify] userScript registered');
        ws.send(JSON.stringify({ type: 'registered', role: 'script' }));
      } else if (msg.role === 'remote') {
        clients.remote.add(ws);
        console.log('[TizenSpotify] Remote registered');
        ws.send(JSON.stringify({ type: 'registered', role: 'remote' }));
      }
      return;
    }

    // Command from remote — forward to userScript
    if (msg.type === 'command') {
      if (clients.script && clients.script.readyState === 1) {
        clients.script.send(JSON.stringify(msg));
        console.log('[TizenSpotify] Command forwarded to script:', msg.action);
      } else {
        console.log('[TizenSpotify] Script not connected, dropping command');
        ws.send(JSON.stringify({ type: 'error', message: 'TV script not connected' }));
      }
      return;
    }

    // Status update from userScript — forward to all remotes
    if (msg.type === 'status') {
      clients.remote.forEach(remote => {
        if (remote.readyState === 1) remote.send(JSON.stringify(msg));
      });
      return;
    }
  });

  ws.on('close', () => {
    if (ws === clients.script) {
      clients.script = null;
      console.log('[TizenSpotify] userScript disconnected');
    }
    clients.remote.delete(ws);
    console.log('[TizenSpotify] Client disconnected');
  });

  ws.on('error', (err) => {
    console.log('[TizenSpotify] WebSocket error:', err);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[TizenSpotify] WebSocket server listening on port ${PORT}`);
});
