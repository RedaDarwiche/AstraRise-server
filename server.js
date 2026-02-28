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
    res.send('AstraRise Multiplayer Server is running!');
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// --- GLOBAL CHAT STATE ---
const chatMessages = [];
const MAX_MESSAGES = 50;
let isChatMuted = false; // New: Global mute state

// --- CRASH GAME STATE ---
let crashState = 'WAITING';
let crashMultiplier = 1.0;
let crashTarget = 1.0;
let crashTimer = 10;
let crashInterval = null;

function generateCrashPoint() {
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
        crashMultiplier = Math.pow(Math.E, 0.00006 * elapsedTime);

        if (crashMultiplier >= crashTarget) {
            clearInterval(crashInterval);
            crashMultiplier = crashTarget;
            crashState = 'CRASHED';
            io.emit('crash_end', { multiplier: crashMultiplier });

            setTimeout(() => {
                startCrashGameLoop();
            }, 5000);

        } else {
            io.emit('crash_tick', { multiplier: crashMultiplier });
        }
    }, 50);
}

// --- SOCKET INTERFACE ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. Send current states to new connection
    socket.emit('chat_history', chatMessages);
    // Tell new user if chat is currently muted
    if (isChatMuted) {
        socket.emit('new_chat_message', { 
            author: 'SYSTEM', 
            text: '🔒 Chat is currently locked by Admins.', 
            isOwner: true, 
            time: Date.now() 
        });
    }
    
    socket.emit('crash_state', {
        state: crashState,
        timer: crashState === 'WAITING' ? crashTimer : null,
        multiplier: crashMultiplier
    });

    // 2. Chat listener (UPDATED WITH MUTE CHECK)
    socket.on('send_chat', (data) => {
        // If chat is muted and user is NOT owner, block the message
        if (isChatMuted && !data.isOwner) {
            return; 
        }

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

    // 3. NEW: Admin Command Listener (Clear Chat / Mute Chat)
    socket.on('admin_command', (data) => {
        // Clear Chat
        if (data.command === 'clear_chat') {
            chatMessages.length = 0; // Empty the array
            io.emit('chat_history', []); // Update everyone's view
            
            // Send system notification
            const sysMsg = { 
                author: 'SYSTEM', 
                text: '🧹 Chat history has been cleared by an Admin.', 
                isOwner: true, 
                time: Date.now() 
            };
            chatMessages.push(sysMsg);
            io.emit('new_chat_message', sysMsg);
        }

        // Toggle Mute
        if (data.command === 'toggle_mute') {
            isChatMuted = !isChatMuted;
            const status = isChatMuted ? 'LOCKED 🔒' : 'UNLOCKED 🔓';
            
            const sysMsg = { 
                author: 'SYSTEM', 
                text: `Global Chat is now ${status}`, 
                isOwner: true, 
                time: Date.now() 
            };
            chatMessages.push(sysMsg);
            io.emit('new_chat_message', sysMsg);
        }
    });

    // 4. Global Announcement (UPDATED)
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

    // 5. Crash Game Bets
    socket.on('crash_place_bet', (data) => {
        socket.broadcast.emit('crash_live_bet', data);
    });

    socket.on('crash_cashout', (data) => {
        socket.broadcast.emit('crash_live_cashout', data);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`AstraRise backend running on port ${PORT}`);
    startCrashGameLoop();
});
