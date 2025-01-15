const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const clients = new Map(); // userId -> ws
const waitingUsers = new Set(); // Set of userIds
const activeRooms = new Map(); // roomId -> { users: [userId1, userId2] }

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');
  let userId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received message:', data);

      switch (data.type) {
        case 'register':
          handleRegister(ws, data);
          break;

        case 'search':
          handleSearch(ws, data);
          break;

        case 'offer':
        case 'answer':
        case 'ice-candidate':
          handleSignaling(ws, data);
          break;

        case 'leave':
          handleLeave(ws, data);
          break;
      }
    } catch (error) {
      console.error('Error processing message:', error);
      ws.send(JSON.stringify({ type: 'error', error: error.message }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected:', userId);
    handleDisconnect(userId);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    handleDisconnect(userId);
  });
});

function handleRegister(ws, data) {
  const { userId } = data;
  console.log('Registering user:', userId);
  
  clients.set(userId, ws);
  ws.userId = userId;
  
  ws.send(JSON.stringify({ 
    type: 'registered', 
    userId 
  }));
}

function handleSearch(ws, data) {
  const userId = ws.userId;
  if (!userId) {
    ws.send(JSON.stringify({ type: 'error', error: 'Not registered' }));
    return;
  }

  console.log('User searching:', userId);

  // Если пользователь уже в очереди, удаляем его
  if (waitingUsers.has(userId)) {
    waitingUsers.delete(userId);
  }

  // Проверяем, есть ли ожидающие пользователи
  if (waitingUsers.size > 0) {
    // Берем первого ожидающего пользователя
    const partnerId = waitingUsers.values().next().value;
    const partnerWs = clients.get(partnerId);

    if (!partnerWs || partnerWs.readyState !== WebSocket.OPEN) {
      // Если партнер отключился, удаляем его и продолжаем поиск
      waitingUsers.delete(partnerId);
      clients.delete(partnerId);
      handleSearch(ws, data);
      return;
    }

    // Удаляем партнера из очереди ожидания
    waitingUsers.delete(partnerId);

    // Создаем новую комнату
    const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    activeRooms.set(roomId, {
      users: [userId, partnerId]
    });

    console.log(`Created room ${roomId} for users ${userId} and ${partnerId}`);

    // Отправляем уведомления обоим пользователям
    // Первый пользователь будет инициатором соединения
    ws.send(JSON.stringify({
      type: 'matched',
      roomId,
      userId,
      partnerId,
      isInitiator: true
    }));

    partnerWs.send(JSON.stringify({
      type: 'matched',
      roomId,
      userId: partnerId,
      partnerId: userId,
      isInitiator: false
    }));
  } else {
    // Добавляем пользователя в очередь ожидания
    waitingUsers.add(userId);
    ws.send(JSON.stringify({ type: 'waiting' }));
    console.log('Added to waiting queue:', userId);
  }
}

function handleSignaling(ws, data) {
  const { roomId, to, type, payload } = data;
  const from = ws.userId;

  console.log(`Signaling: ${type} from ${from} to ${to}`);

  const room = activeRooms.get(roomId);
  if (!room) {
    console.log('Room not found:', roomId);
    return;
  }

  if (!room.users.includes(from) || !room.users.includes(to)) {
    console.log('User not in room:', from, to);
    return;
  }

  const targetWs = clients.get(to);
  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
    console.log('Target user not connected:', to);
    return;
  }

  targetWs.send(JSON.stringify({
    type,
    payload,
    from,
    roomId
  }));
}

function handleLeave(ws, data) {
  const userId = ws.userId;
  handleDisconnect(userId);
}

function handleDisconnect(userId) {
  if (!userId) return;

  console.log('Handling disconnect for user:', userId);

  // Удаляем из списка клиентов
  clients.delete(userId);

  // Удаляем из очереди ожидания
  waitingUsers.delete(userId);

  // Ищем комнату пользователя
  for (const [roomId, room] of activeRooms.entries()) {
    if (room.users.includes(userId)) {
      // Находим партнера
      const partnerId = room.users.find(id => id !== userId);
      const partnerWs = clients.get(partnerId);

      // Уведомляем партнера
      if (partnerWs && partnerWs.readyState === WebSocket.OPEN) {
        partnerWs.send(JSON.stringify({ type: 'partner-left' }));
      }

      // Удаляем комнату
      activeRooms.delete(roomId);
      console.log(`Room ${roomId} deleted due to user ${userId} disconnect`);
      break;
    }
  }
}

// Очистка неактивных пользователей
setInterval(() => {
  for (const [userId, ws] of clients.entries()) {
    if (ws.readyState !== WebSocket.OPEN) {
      handleDisconnect(userId);
    }
  }
}, 30000);

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 