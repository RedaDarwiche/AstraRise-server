const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

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
let isChatMuted = false;

// --- CRASH GAME STATE ---
let crashState = 'WAITING';
let crashMultiplier = 1.0;
let crashTarget = 1.0;
let crashTimer = 10;
let crashInterval = null;

function generateCrashPoint() {
    const e = 2 ** 32;
    const h = require('crypto').randomBytes(4).readUInt32LE(0);
    if (h % 100 === 0) return 1.00;
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

    socket.emit('chat_history', chatMessages);
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

    // Chat
    socket.on('send_chat', (data) => {
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

    // Admin Commands
    socket.on('admin_command', (data) => {
        if (data.command === 'clear_chat') {
            chatMessages.length = 0;
            io.emit('chat_history', []);
            
            const sysMsg = { 
                author: 'SYSTEM', 
                text: '🧹 Chat history has been cleared by an Admin.', 
                isOwner: true, 
                time: Date.now() 
            };
            chatMessages.push(sysMsg);
            io.emit('new_chat_message', sysMsg);
        }

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
        
        // Gift coins notification
        if (data.command === 'gift_coins') {
            io.emit('gift_notification', {
                targetUsername: data.targetUsername,
                targetId: data.targetId,
                amount: data.amount
            });
        }
    });

    // Announcements
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
        
        // Also emit as dedicated announcement event
        io.emit('global_announcement', { text: data.text });
    });

    // Crash bets
    socket.on('crash_place_bet', (data) => {
        socket.broadcast.emit('crash_live_bet', data);
    });

    socket.on('crash_cashout', (data) => {
        socket.broadcast.emit('crash_live_cashout', data);
    });
    
    // Donation socket relay
    socket.on('donation_sent', (data) => {
        io.emit('donation_received', {
            fromUsername: data.fromUsername,
            toUsername: data.toUsername,
            toUserId: data.toUserId,
            amount: data.amount
        });
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
