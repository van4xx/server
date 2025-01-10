const { PeerServer } = require('peer');
const fs = require('fs');

let sslOptions = {};

// Проверяем окружение
if (process.env.NODE_ENV === 'production') {
  sslOptions = {
    ssl: {
      key: fs.readFileSync('/etc/letsencrypt/live/ruletka.top/privkey.pem'),
      cert: fs.readFileSync('/etc/letsencrypt/live/ruletka.top/fullchain.pem')
    }
  };
}

const peerServer = PeerServer({
  port: 9000,
  path: '/peerjs',
  ...sslOptions,
  allow_discovery: true,
  proxied: true
});

peerServer.on('connection', (client) => {
  console.log('Client connected to peer server:', client.id);
});

peerServer.on('disconnect', (client) => {
  console.log('Client disconnected from peer server:', client.id);
});

module.exports = peerServer; 