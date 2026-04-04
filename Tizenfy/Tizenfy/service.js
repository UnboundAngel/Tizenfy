/**
 * TizenSpotify - service.js
 * WebSocket server running on the TV (Node.js via TizenBrew serviceFile)
 * iPhone remote connects here, sends commands, we broadcast to userScript
 */

const http = require('http');
const WebSocket = require('ws');

const PORT = 8765;

// Track connected clients by type
const clients = {
  script: null,   // userScript.js running in the TV webview
  remote: new Set(), // iPhone remotes
};

const server = http.createServer((req, res) => {
  // Serve a simple status page so you can verify it's running
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('TizenSpotify WebSocket server running');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('[TizenSpotify] New connection from', req.socket.remoteAddress);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.log('[TizenSpotify] Bad message:', raw);
      return;
    }

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
      if (clients.script && clients.script.readyState === WebSocket.OPEN) {
        clients.script.send(JSON.stringify(msg));
        console.log('[TizenSpotify] Command forwarded to script:', msg.action);
      } else {
        console.log('[TizenSpotify] Script not connected, dropping command');
        // Notify remote that script isn't connected
        ws.send(JSON.stringify({ type: 'error', message: 'TV script not connected' }));
      }
      return;
    }

    // Status update from userScript — forward to all remotes
    if (msg.type === 'status') {
      clients.remote.forEach(remote => {
        if (remote.readyState === WebSocket.OPEN) {
          remote.send(JSON.stringify(msg));
        }
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
