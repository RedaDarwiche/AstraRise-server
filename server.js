--- START OF FILE server.js ---
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
const chatMessages =[];
const MAX_MESSAGES = 50;
let isChatMuted = false;

// --- CRASH GAME STATE ---
let crashState = 'WAITING';
let crashMultiplier = 1.0;
let crashTarget = 1.0;
let crashTimer = 10;
let crashInterval = null;

// --- CASE BATTLES STATE ---
let activeBattles =[];
const CASES = {
    starter: { items: ['noob', 'player', 'grinder'] },
    pro: { items: ['hustler', 'high_roller', 'shark'] },
    god: { items: ['whale', 'vip', 'legend'] }
};
const ITEM_VALUES = {
    'noob': 50, 'player': 100, 'grinder': 300,
    'hustler': 450, 'high_roller': 600, 'shark': 900,
    'whale': 1300, 'vip': 1600, 'legend': 2000
};
function generateId() { return Math.random().toString(36).substr(2, 9); }

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
            setTimeout(() => { startCrashGameLoop(); }, 5000);
        } else {
            io.emit('crash_tick', { multiplier: crashMultiplier });
        }
    }, 50);
}

// --- SOCKET INTERFACE ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Initial Sync
    socket.emit('chat_history', chatMessages);
    if (isChatMuted) {
        socket.emit('new_chat_message', { 
            author: 'SYSTEM', text: '🔒 Chat is currently locked by Admins.', isOwner: true, time: Date.now(), id: 'sys_1'
        });
    }
    socket.emit('crash_state', { state: crashState, timer: crashState === 'WAITING' ? crashTimer : null, multiplier: crashMultiplier });
    socket.emit('battles_update', activeBattles);

    // CHAT
    socket.on('send_chat', (data) => {
        if (isChatMuted && !data.isOwner) return; 

        const msg = {
            author: data.author || 'User',
            text: data.text || '',
            isOwner: !!data.isOwner,
            equippedRank: data.equippedRank || null,
            time: Date.now(),
            id: data.id || generateId()
        };

        chatMessages.push(msg);
        if (chatMessages.length > MAX_MESSAGES) chatMessages.shift();
        io.emit('new_chat_message', msg);
    });

    // DONATIONS
    socket.on('donate_coins', (data) => {
        io.emit('donation_received', data);
    });

    // ADMIN COMMANDS
    socket.on('admin_command', (data) => {
        if (data.command === 'clear_chat') {
            chatMessages.length = 0;
            io.emit('chat_history',[]);
            const sysMsg = { author: 'SYSTEM', text: '🧹 Chat history has been cleared by an Admin.', isOwner: true, time: Date.now(), id: generateId() };
            chatMessages.push(sysMsg);
            io.emit('new_chat_message', sysMsg);
        }
        if (data.command === 'toggle_mute') {
            isChatMuted = !isChatMuted;
            const status = isChatMuted ? 'LOCKED 🔒' : 'UNLOCKED 🔓';
            const sysMsg = { author: 'SYSTEM', text: `Global Chat is now ${status}`, isOwner: true, time: Date.now(), id: generateId() };
            chatMessages.push(sysMsg);
            io.emit('new_chat_message', sysMsg);
        }
        if (data.command === 'gift_coins') {
            io.emit('gift_notification', data);
        }
    });

    socket.on('global_announcement', (data) => {
        const msg = { author: '📢 ANNOUNCEMENT', text: data.text || '', isOwner: true, time: Date.now(), id: generateId() };
        chatMessages.push(msg);
        if (chatMessages.length > MAX_MESSAGES) chatMessages.shift();
        io.emit('new_chat_message', msg);
        io.emit('global_announcement', { text: data.text });
    });

    // CRASH BETS
    socket.on('crash_place_bet', (data) => { socket.broadcast.emit('crash_live_bet', data); });
    socket.on('crash_cashout', (data) => { socket.broadcast.emit('crash_live_cashout', data); });

    // CASE BATTLES
    socket.on('create_battle', (data) => {
        const battle = {
            id: generateId(),
            caseType: data.caseType,
            player1: { id: socket.id, username: data.username, items:[], value: 0 },
            player2: null,
            status: 'waiting'
        };
        activeBattles.push(battle);
        io.emit('battles_update', activeBattles);
    });

    socket.on('join_battle', (data) => {
        const battle = activeBattles.find(b => b.id === data.battleId);
        if(battle && battle.status === 'waiting') {
            battle.player2 = { id: socket.id, username: data.username, items:[], value: 0 };
            battle.status = 'spinning';
            
            const caseData = CASES[battle.caseType];
            const p1Item = caseData.items[Math.floor(Math.random() * caseData.items.length)];
            const p2Item = caseData.items[Math.floor(Math.random() * caseData.items.length)];
            
            battle.player1.items = [p1Item];
            battle.player2.items =[p2Item];
            battle.player1.value = ITEM_VALUES[p1Item];
            battle.player2.value = ITEM_VALUES[p2Item];
            
            let winner = 'tie';
            if(battle.player1.value > battle.player2.value) winner = battle.player1.username;
            else if(battle.player2.value > battle.player1.value) winner = battle.player2.username;
            
            battle.winner = winner;
            
            io.emit('battle_spin', battle);
            
            setTimeout(() => {
                activeBattles = activeBattles.filter(b => b.id !== battle.id);
                io.emit('battles_update', activeBattles);
            }, 6000);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Clean up empty battles
        activeBattles = activeBattles.filter(b => b.player1.id !== socket.id || b.player2 !== null);
        io.emit('battles_update', activeBattles);
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`AstraRise backend running on port ${PORT}`);
    startCrashGameLoop();
});
--- END OF FILE server.js ---
