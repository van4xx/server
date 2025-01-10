const { PeerServer } = require('peer');

const peerServer = PeerServer({
  port: 443,
  path: '/peerjs',
  ssl: {
    key: '/etc/letsencrypt/live/ruletka.top/privkey.pem',
    cert: '/etc/letsencrypt/live/ruletka.top/fullchain.pem'
  }
});

peerServer.on('connection', (client) => {
  console.log('Client connected:', client.id);
});

peerServer.on('disconnect', (client) => {
  console.log('Client disconnected:', client.id);
}); 