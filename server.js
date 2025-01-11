const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["https://ruletka.top", "http://localhost:3000"],
    methods: ["GET", "POST"]
  },
  path: '/socket.io/'
});

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

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 