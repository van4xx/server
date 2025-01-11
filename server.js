const express = require('express');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const cors = require('cors');
const { ExpressPeerServer } = require('peer');

const app = express();
app.use(cors());

// SSL конфигурация
const credentials = process.env.NODE_ENV === 'production' ? {
  key: fs.readFileSync('/etc/letsencrypt/live/ruletka.top/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/ruletka.top/fullchain.pem')
} : null;

const server = process.env.NODE_ENV === 'production' 
  ? https.createServer(credentials, app)
  : require('http').createServer(app);

// Socket.IO сервер
const io = new Server(server, {
  cors: {
    origin: ["https://ruletka.top", "http://localhost:3000"],
    methods: ["GET", "POST"]
  },
  path: '/socket.io/'
});

// PeerJS сервер
const peerServer = ExpressPeerServer(server, {
  path: '/myapp',
  ssl: credentials
});

app.use('/peerjs', peerServer);

const searchingUsers = {
  audio: new Set(),
  video: new Set()
};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('startSearch', ({ peerId }) => {
    const userId = socket.id;
    const mode = socket.chatMode || 'video';
    
    searchingUsers[mode].delete(userId);
    searchingUsers[mode].add(userId);
    
    socket.peerId = peerId;
    
    for (const partnerId of searchingUsers[mode]) {
      if (partnerId !== userId && io.sockets.sockets.has(partnerId)) {
        const partnerSocket = io.sockets.sockets.get(partnerId);
        
        searchingUsers[mode].delete(userId);
        searchingUsers[mode].delete(partnerId);
        
        socket.emit('chatStart', { partnerId: partnerSocket.peerId });
        partnerSocket.emit('chatStart', { partnerId: peerId });
        
        break;
      }
    }
  });

  socket.on('setChatMode', (mode) => {
    socket.chatMode = mode;
  });

  socket.on('cancelSearch', () => {
    const mode = socket.chatMode || 'video';
    searchingUsers[mode].delete(socket.id);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    searchingUsers.audio.delete(socket.id);
    searchingUsers.video.delete(socket.id);
  });
});

const PORT = process.env.NODE_ENV === 'production' ? 443 : 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 