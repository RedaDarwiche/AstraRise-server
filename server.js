const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/', (req, res) => {
    res.send('AstraRise Multiplayer Server is running! Open the frontend to play.');
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow frontend to connect from anywhere (Vercel, localhost)
        methods: ["GET", "POST"]
    }
});

// --- GLOBAL CHAT STATE ---
const chatMessages = [];
const MAX_MESSAGES = 50;

// --- CRASH GAME STATE ---
let crashState = 'WAITING'; // WAITING, RUNNING, CRASHED
let crashMultiplier = 1.0;
let crashTarget = 1.0;
let crashTimer = 10;
let crashInterval = null;
let gameLoopInterval = null;

function generateCrashPoint() {
    // Basic crash point generation (1% instant crash edge)
    const e = 2 ** 32;
    const h = require('crypto').randomBytes(4).readUInt32LE(0);

    if (h % 100 === 0) return 1.00; // 1% edge

    const crashPoint = Math.max(1.00, (100 * e - h) / (e - h)) / 100;
    return Math.max(1.01, parseFloat(crashPoint.toFixed(2)));
}

function startCrashGameLoop() {
    crashState = 'WAITING';
    crashTimer = 10;
    crashMultiplier = 1.0;
    io.emit('crash_state', { state: crashState, timer: crashTimer, multiplier: crashMultiplier });

    // 10 second waiting phase
    let waitInterval = setInterval(() => {
        crashTimer--;
        io.emit('crash_timer', { timer: crashTimer });

        if (crashTimer <= 0) {
            clearInterval(waitInterval);
            runCrashPhase();
        }
    }, 1000);
}

function runCrashPhase() {
    crashState = 'RUNNING';
    crashTarget = generateCrashPoint();
    crashMultiplier = 1.0;

    io.emit('crash_state', { state: crashState, multiplier: crashMultiplier });

    let startTime = Date.now();

    crashInterval = setInterval(() => {
        const elapsedTime = Date.now() - startTime;
        // Exponential curve
        crashMultiplier = Math.pow(Math.E, 0.00006 * elapsedTime);

        if (crashMultiplier >= crashTarget) {
            // Crashed!
            clearInterval(crashInterval);
            crashMultiplier = crashTarget;
            crashState = 'CRASHED';
            io.emit('crash_end', { multiplier: crashMultiplier });

            // 5 second cooldown
            setTimeout(() => {
                startCrashGameLoop();
            }, 5000);

        } else {
            // Tick
            io.emit('crash_tick', { multiplier: crashMultiplier });
        }
    }, 50); // 20 ticks per second
}


// --- SOCKET INTERFACE ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Send current states to new connection
    socket.emit('chat_history', chatMessages);
    socket.emit('crash_state', {
        state: crashState,
        timer: crashState === 'WAITING' ? crashTimer : null,
        multiplier: crashMultiplier
    });

    // Chat listener
    socket.on('send_chat', (data) => {
        // data expects { author: string, text: string, isOwner: boolean, equippedRank: string|null }
        const msg = {
            author: data.author || 'User',
            text: data.text || '',
            isOwner: !!data.isOwner,
            equippedRank: data.equippedRank || null,
            time: Date.now()
        };

        chatMessages.push(msg);
        if (chatMessages.length > MAX_MESSAGES) chatMessages.shift();

        io.emit('new_chat_message', msg);
    });

    // Crash bet listener (just broadcasts to others so they see live bets)
    socket.on('crash_place_bet', (data) => {
        // Broadcast to everyone else that a bet was placed
        socket.broadcast.emit('crash_live_bet', data);
    });

    socket.on('crash_cashout', (data) => {
        socket.broadcast.emit('crash_live_cashout', data);
    });

    // Global announcement from owner
    socket.on('global_announcement', (data) => {
        const msg = {
            author: '📢 ANNOUNCEMENT',
            text: data.text || '',
            isOwner: true,
            time: Date.now()
        };
        chatMessages.push(msg);
        if (chatMessages.length > MAX_MESSAGES) chatMessages.shift();
        io.emit('new_chat_message', msg);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`AstraRise backend running on port ${PORT}`);

    // Start the global crash loop
    startCrashGameLoop();
});
