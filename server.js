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
    methods: ["GET", "POST"],
    credentials: false
  },
  path: '/socket.io/'
});

// Хранение пользователей в поиске
const searchingUsers = {
  audio: new Set(),
  video: new Set()
};

// Активные соединения
const connections = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('startSearch', () => {
    const userId = socket.id;
    const mode = socket.chatMode || 'video';
    
    // Очищаем предыдущие состояния
    searchingUsers.audio.delete(userId);
    searchingUsers.video.delete(userId);
    
    // Добавляем в поиск
    searchingUsers[mode].add(userId);
    
    // Ищем партнера
    for (const partnerId of searchingUsers[mode]) {
      if (partnerId !== userId && io.sockets.sockets.has(partnerId)) {
        const room = `room_${userId}_${partnerId}`;
        
        // Удаляем обоих из поиска
        searchingUsers[mode].delete(userId);
        searchingUsers[mode].delete(partnerId);
        
        // Подключаем к комнате
        socket.join(room);
        io.sockets.sockets.get(partnerId).join(room);
        
        // Сохраняем соединение
        connections.set(userId, { partner: partnerId, room });
        connections.set(partnerId, { partner: userId, room });
        
        // Уведомляем обоих
        io.to(room).emit('chatStart', { room });
        break;
      }
    }
  });

  socket.on('setChatMode', (mode) => {
    console.log(`User ${socket.id} set mode to ${mode}`);
    socket.chatMode = mode;
  });

  socket.on('cancelSearch', () => {
    const mode = socket.chatMode || 'video';
    searchingUsers[mode].delete(socket.id);
    console.log(`User ${socket.id} cancelled search`);
  });

  socket.on('signal', ({ signal, room }) => {
    console.log(`Signal from ${socket.id} in room ${room}:`, signal.type);
    const connection = connections.get(socket.id);
    
    if (connection) {
      const partnerSocket = io.sockets.sockets.get(connection.partner);
      if (partnerSocket) {
        console.log('Forwarding signal to partner:', connection.partner);
        partnerSocket.emit('signal', signal);
      } else {
        console.error('Partner socket not found');
      }
    } else {
      console.error('Connection not found for socket:', socket.id);
    }
  });

  socket.on('message', (message) => {
    const connection = connections.get(socket.id);
    if (connection) {
      io.to(connection.room).emit('message', {
        ...message,
        sender: socket.id
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Очищаем все состояния пользователя
    searchingUsers.audio.delete(socket.id);
    searchingUsers.video.delete(socket.id);
    
    const connection = connections.get(socket.id);
    if (connection) {
      // Уведомляем партнера
      const partnerSocket = io.sockets.sockets.get(connection.partner);
      if (partnerSocket) {
        partnerSocket.emit('partnerLeft');
      }
      
      // Очищаем соединения
      connections.delete(connection.partner);
      connections.delete(socket.id);
    }
  });

  socket.on('nextPartner', () => {
    const connection = connections.get(socket.id);
    if (connection) {
      // Уведомляем текущего партнера
      const partnerSocket = io.sockets.sockets.get(connection.partner);
      if (partnerSocket) {
        partnerSocket.emit('partnerLeft');
      }
      
      // Очищаем старые соединения
      connections.delete(connection.partner);
      connections.delete(socket.id);
      
      // Начинаем новый поиск
      const mode = socket.chatMode || 'video';
      searchingUsers[mode].add(socket.id);
      socket.emit('searchStart');
    }
  });
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 