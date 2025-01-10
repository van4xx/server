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

let worker;
const rooms = new Map();

(async () => {
  worker = await mediasoup.createWorker({
    logLevel: 'debug',
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });

  console.log('mediasoup worker created');
})();

const mediaCodecs = [
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
  }
];

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

  // Остальные обработчики...
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 