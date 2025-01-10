const express = require('express');
const http = require('http');
const mediasoup = require('mediasoup');
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
  }
});

// Конфигурация mediasoup
const config = {
  // Настройки Worker
  worker: {
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
    logLevel: 'warn',
    logTags: [
      'info',
      'ice',
      'dtls',
      'rtp',
      'srtp',
      'rtcp'
    ],
  },
  // Настройки Router
  router: {
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
          'x-google-start-bitrate': 1000
        }
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '4d0032',
          'level-asymmetry-allowed': 1
        }
      }
    ]
  },
  // Настройки WebRtcTransport
  webRtcTransport: {
    listenIps: [
      {
        ip: '0.0.0.0',
        announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1' // Замените на ваш публичный IP
      }
    ],
    initialAvailableOutgoingBitrate: 1000000,
    minimumAvailableOutgoingBitrate: 600000,
    maxSctpMessageSize: 262144,
    maxIncomingBitrate: 1500000
  }
};

let worker;
const rooms = new Map();

// Создаем worker
async function createWorker() {
  worker = await mediasoup.createWorker({
    logLevel: config.worker.logLevel,
    logTags: config.worker.logTags,
    rtcMinPort: config.worker.rtcMinPort,
    rtcMaxPort: config.worker.rtcMaxPort
  });

  worker.on('died', () => {
    console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });

  return worker;
}

// Инициализация при запуске
async function init() {
  try {
    worker = await createWorker();
    console.log('mediasoup worker created');
  } catch (error) {
    console.error('Failed to create mediasoup worker:', error);
    process.exit(1);
  }
}

init();

io.on('connection', async (socket) => {
  console.log('client connected', socket.id);
  
  socket.on('createRoom', async () => {
    try {
      const router = await worker.createRouter({ mediaCodecs });
      rooms.set(socket.id, { router, peers: new Map() });
      
      const rtpCapabilities = router.rtpCapabilities;
      socket.emit('roomCreated', { rtpCapabilities });
    } catch (error) {
      console.error('Error creating room', error);
    }
  });

  socket.on('joinRoom', async ({ roomId }, callback) => {
    const room = rooms.get(roomId);
    if (!room) {
      return callback({ error: 'Room not found' });
    }

    const router = room.router;
    const rtpCapabilities = router.rtpCapabilities;
    callback({ rtpCapabilities });
  });

  socket.on('createTransport', async ({ sender }, callback) => {
    try {
      const room = rooms.get(socket.id);
      const router = room.router;

      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: null }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });

      transport.on('dtlsstatechange', dtlsState => {
        if (dtlsState === 'closed') {
          transport.close();
        }
      });

      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        }
      });

      if (sender) {
        room.peers.set(socket.id, { sendTransport: transport });
      } else {
        room.peers.set(socket.id, { ...room.peers.get(socket.id), recvTransport: transport });
      }
    } catch (error) {
      console.error('Error creating transport', error);
      callback({ error: error.message });
    }
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters, sender }, callback) => {
    try {
      const room = rooms.get(socket.id);
      if (!room) {
        throw new Error('Room not found');
      }

      const transport = sender
        ? room.peers.get(socket.id).sendTransport
        : room.peers.get(socket.id).recvTransport;

      await transport.connect({ dtlsParameters });
      callback();
    } catch (error) {
      console.error('Error connecting transport:', error);
      callback({ error: error.message });
    }
  });

  socket.on('produce', async ({ kind, rtpParameters }, callback) => {
    try {
      const room = rooms.get(socket.id);
      if (!room) {
        throw new Error('Room not found');
      }

      const transport = room.peers.get(socket.id).sendTransport;
      const producer = await transport.produce({ kind, rtpParameters });

      callback({ id: producer.id });

      // Уведомляем других участников о новом продюсере
      socket.to(room.id).emit('newProducer', {
        producerId: producer.id,
        kind
      });
    } catch (error) {
      console.error('Error producing:', error);
      callback({ error: error.message });
    }
  });

  socket.on('consume', async ({ rtpCapabilities, producerId, transportId }, callback) => {
    try {
      const room = rooms.get(socket.id);
      if (!room) {
        throw new Error('Room not found');
      }

      const router = room.router;
      const transport = room.peers.get(socket.id).recvTransport;

      if (!router.canConsume({
        producerId,
        rtpCapabilities,
      })) {
        throw new Error('Cannot consume');
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      });

      callback({
        id: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (error) {
      console.error('Error consuming:', error);
      callback({ error: error.message });
    }
  });

  socket.on('resume', async () => {
    try {
      const room = rooms.get(socket.id);
      if (!room) {
        throw new Error('Room not found');
      }

      const consumer = room.peers.get(socket.id).consumer;
      await consumer.resume();
    } catch (error) {
      console.error('Error resuming consumer:', error);
    }
  });

  // Остальные обработчики...
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 