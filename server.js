const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.send('AstraRise Multiplayer Server is running!'));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- CHAT ---
const chatMessages = [];
const MAX_MESSAGES = 50;
let isChatMuted = false;

// --- CRASH ---
let crashState = 'WAITING';
let crashMultiplier = 1.0;
let crashTarget = 1.0;
let crashTimer = 10;
let crashInterval = null;

// --- CASE BATTLE LOBBIES ---
let caseLobbies = [];

const CASE_TAGS_SERVER = [
    { id: 'common_tag', name: 'Common', value: 10, rarity: 40 },
    { id: 'uncommon_tag', name: 'Uncommon', value: 25, rarity: 25 },
    { id: 'rare_tag', name: 'Rare', value: 60, rarity: 15 },
    { id: 'epic_tag', name: 'Epic', value: 150, rarity: 10 },
    { id: 'legendary_tag', name: 'Legendary', value: 400, rarity: 5 },
    { id: 'mythic_tag', name: 'Mythic', value: 800, rarity: 3 },
    { id: 'divine_tag', name: 'Divine', value: 2000, rarity: 1.5 },
    { id: 'astral_tag', name: 'Astral', value: 5000, rarity: 0.5 },
    { id: 'celestial_tag', name: 'Celestial', value: 12000, rarity: 0.3 },
    { id: 'transcendent_tag', name: 'Transcendent', value: 30000, rarity: 0.15 },
    { id: 'eternal_tag', name: 'Eternal', value: 75000, rarity: 0.08 },
    { id: 'godlike_tag', name: 'Godlike', value: 200000, rarity: 0.04 },
    { id: 'omega_tag', name: 'Omega', value: 500000, rarity: 0.02 },
    { id: 'infinity_tag', name: 'Infinity', value: 1500000, rarity: 0.01 },
    { id: 'void_tag', name: 'Void', value: 5000000, rarity: 0.005 },
    { id: 'astra_supreme_tag', name: 'Astra Supreme', value: 20000000, rarity: 0.002 }
];

const CASE_TIERS_SERVER = [
    { id: 'basic', cost: 100, tags: ['common_tag', 'uncommon_tag'] },
    { id: 'starter', cost: 250, tags: ['common_tag', 'uncommon_tag', 'rare_tag'] },
    { id: 'mid', cost: 500, tags: ['uncommon_tag', 'rare_tag', 'epic_tag', 'legendary_tag'] },
    { id: 'hunter', cost: 1000, tags: ['rare_tag', 'epic_tag', 'legendary_tag', 'mythic_tag'] },
    { id: 'premium', cost: 2500, tags: ['epic_tag', 'legendary_tag', 'mythic_tag', 'divine_tag'] },
    { id: 'ultra', cost: 5000, tags: ['legendary_tag', 'mythic_tag', 'divine_tag', 'astral_tag'] },
    { id: 'astral', cost: 10000, tags: ['mythic_tag', 'divine_tag', 'astral_tag', 'celestial_tag'] },
    { id: 'phantom', cost: 25000, tags: ['divine_tag', 'astral_tag', 'celestial_tag', 'transcendent_tag'] },
    { id: 'eclipse', cost: 50000, tags: ['astral_tag', 'celestial_tag', 'transcendent_tag', 'eternal_tag'] },
    { id: 'inferno', cost: 100000, tags: ['celestial_tag', 'transcendent_tag', 'eternal_tag', 'godlike_tag'] },
    { id: 'tempest', cost: 250000, tags: ['transcendent_tag', 'eternal_tag', 'godlike_tag', 'omega_tag'] },
    { id: 'nebula', cost: 500000, tags: ['eternal_tag', 'godlike_tag', 'omega_tag', 'infinity_tag'] },
    { id: 'sovereign', cost: 1000000, tags: ['godlike_tag', 'omega_tag', 'infinity_tag', 'void_tag'] },
    { id: 'oblivion', cost: 10000000, tags: ['omega_tag', 'infinity_tag', 'void_tag', 'astra_supreme_tag'] },
    { id: 'singularity', cost: 100000000, tags: ['infinity_tag', 'void_tag', 'astra_supreme_tag'] },
    { id: 'genesis', cost: 1000000000, tags: ['void_tag', 'astra_supreme_tag'] }
];

function serverGetRandomTag(tagIds) {
    const pool = CASE_TAGS_SERVER.filter(t => tagIds.includes(t.id));
    if (pool.length === 0) return CASE_TAGS_SERVER[0];
    const totalWeight = pool.reduce((s, t) => s + t.rarity, 0);
    let rand = Math.random() * totalWeight;
    for (const tag of pool) {
        rand -= tag.rarity;
        if (rand <= 0) return tag;
    }
    return pool[0];
}

function runCaseBattle(lobby, player2Id, player2Name) {
    const tier = CASE_TIERS_SERVER.find(t => t.id === lobby.caseId) || CASE_TIERS_SERVER[0];
    const p1Tag = serverGetRandomTag(tier.tags);
    const p2Tag = serverGetRandomTag(tier.tags);

    const battleData = {
        lobbyId: lobby.id,
        caseId: lobby.caseId,
        player1Id: lobby.creatorId,
        player1Name: lobby.creatorName,
        player1TagId: p1Tag.id,
        player2Id: player2Id,
        player2Name: player2Name,
        player2TagId: p2Tag.id,
        winnerId: p1Tag.value >= p2Tag.value ? lobby.creatorId : player2Id
    };

    io.emit('case_battle_start', battleData);
    caseLobbies = caseLobbies.filter(l => l.id !== lobby.id);
}

// --- CRASH ---
function generateCrashPoint() {
    const e = 2 ** 32;
    const h = crypto.randomBytes(4).readUInt32LE(0);
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
            setTimeout(() => startCrashGameLoop(), 5000);
        } else {
            io.emit('crash_tick', { multiplier: crashMultiplier });
        }
    }, 50);
}

// --- SOCKET ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.emit('chat_history', chatMessages);
    if (isChatMuted) {
        socket.emit('new_chat_message', { author: 'SYSTEM', text: '🔒 Chat is currently locked by Admins.', isOwner: true, time: Date.now() });
    }
    socket.emit('crash_state', { state: crashState, timer: crashState === 'WAITING' ? crashTimer : null, multiplier: crashMultiplier });

    // Chat
    socket.on('send_chat', (data) => {
        if (isChatMuted && !data.isOwner) return;
        const msg = { author: data.author || 'User', text: data.text || '', isOwner: !!data.isOwner, equippedRank: data.equippedRank || null, time: Date.now() };
        chatMessages.push(msg);
        if (chatMessages.length > MAX_MESSAGES) chatMessages.shift();
        io.emit('new_chat_message', msg);
    });

    // Admin
    socket.on('admin_command', (data) => {
        if (data.command === 'clear_chat') {
            chatMessages.length = 0;
            io.emit('chat_history', []);
            const sysMsg = { author: 'SYSTEM', text: '🧹 Chat history has been cleared by an Admin.', isOwner: true, time: Date.now() };
            chatMessages.push(sysMsg);
            io.emit('new_chat_message', sysMsg);
        }
        if (data.command === 'toggle_mute') {
            isChatMuted = !isChatMuted;
            const status = isChatMuted ? 'LOCKED 🔒' : 'UNLOCKED 🔓';
            const sysMsg = { author: 'SYSTEM', text: `Global Chat is now ${status}`, isOwner: true, time: Date.now() };
            chatMessages.push(sysMsg);
            io.emit('new_chat_message', sysMsg);
        }
        if (data.command === 'gift_coins') {
            io.emit('gift_notification', { targetUsername: data.targetUsername, targetId: data.targetId, amount: data.amount });
        }
    });

    // Announcements
    socket.on('global_announcement', (data) => {
        const msg = { author: '📢 ANNOUNCEMENT', text: data.text || '', isOwner: true, time: Date.now() };
        chatMessages.push(msg);
        if (chatMessages.length > MAX_MESSAGES) chatMessages.shift();
        io.emit('new_chat_message', msg);
        io.emit('global_announcement', { text: data.text });
    });

    // Crash
    socket.on('crash_place_bet', (data) => socket.broadcast.emit('crash_live_bet', data));
    socket.on('crash_cashout', (data) => socket.broadcast.emit('crash_live_cashout', data));

    // Donations
    socket.on('donation_sent', (data) => {
        io.emit('donation_received', { fromUsername: data.fromUsername, toUsername: data.toUsername, toUserId: data.toUserId, amount: data.amount });
    });

    // === CASE BATTLE LOBBIES ===
    socket.on('case_get_lobbies', () => {
        socket.emit('case_lobby_list', caseLobbies);
    });

    socket.on('case_create_lobby', (data) => {
        const lobby = {
            id: crypto.randomUUID(),
            creatorId: data.creatorId,
            creatorName: data.creatorName,
            caseId: data.caseId,
            cost: data.cost,
            socketId: socket.id,
            createdAt: Date.now()
        };
        caseLobbies.push(lobby);
        io.emit('case_lobby_created', lobby);
    });

    socket.on('case_cancel_lobby', (data) => {
        caseLobbies = caseLobbies.filter(l => l.id !== data.lobbyId);
        io.emit('case_lobby_removed', data.lobbyId);
    });

    socket.on('case_join_lobby', (data) => {
        const lobby = caseLobbies.find(l => l.id === data.lobbyId);
        if (!lobby) {
            socket.emit('case_lobby_removed', data.lobbyId);
            return;
        }
        if (lobby.creatorId === data.joinerId) {
            return;
        }
        runCaseBattle(lobby, data.joinerId, data.joinerName);
    });

    socket.on('case_bot_join', (data) => {
        const lobby = caseLobbies.find(l => l.id === data.lobbyId);
        if (!lobby) return;
        runCaseBattle(lobby, 'bot', '🤖 Bot');
    });

    // Cleanup lobbies on disconnect
    socket.on('disconnect', () => {
        const removed = caseLobbies.filter(l => l.socketId === socket.id);
        removed.forEach(l => io.emit('case_lobby_removed', l.id));
        caseLobbies = caseLobbies.filter(l => l.socketId !== socket.id);
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`AstraRise backend running on port ${PORT}`);
    startCrashGameLoop();
});

