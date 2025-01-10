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

  // Остальные обработчики остаются без изменений
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 