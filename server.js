const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.send('AstraRise Server Running'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const chatMessages = [];
const MAX_MESSAGES = 50;
let isChatMuted = false;
let isSlowMode = false;
let bannedChatUsers = [];
const slowModeCooldowns = {};
let serverMode = 'normal';
let globalMultiplier = 1.0;

let crashState = 'WAITING', crashMultiplier = 1.0, crashTarget = 1.0, crashTimer = 10, crashInterval = null;
let forcedCrashTarget = null;
let caseLobbies = [];

const CASE_TAGS_SERVER = [
    { id: 'common_tag', value: 10, rarity: 40 }, { id: 'uncommon_tag', value: 25, rarity: 25 },
    { id: 'rare_tag', value: 60, rarity: 15 }, { id: 'epic_tag', value: 150, rarity: 10 },
    { id: 'legendary_tag', value: 400, rarity: 5 }, { id: 'mythic_tag', value: 800, rarity: 3 },
    { id: 'divine_tag', value: 2000, rarity: 1.5 }, { id: 'astral_tag', value: 5000, rarity: 0.5 },
    { id: 'celestial_tag', value: 12000, rarity: 0.3 }, { id: 'transcendent_tag', value: 30000, rarity: 0.15 },
    { id: 'eternal_tag', value: 75000, rarity: 0.08 }, { id: 'godlike_tag', value: 200000, rarity: 0.04 },
    { id: 'omega_tag', value: 500000, rarity: 0.02 }, { id: 'infinity_tag', value: 1500000, rarity: 0.01 },
    { id: 'void_tag', value: 5000000, rarity: 0.005 }, { id: 'astra_supreme_tag', value: 20000000, rarity: 0.002 }
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
    if (!pool.length) return CASE_TAGS_SERVER[0];
    const total = pool.reduce((s, t) => s + t.rarity, 0);
    let r = Math.random() * total;
    for (const t of pool) { r -= t.rarity; if (r <= 0) return t; }
    return pool[0];
}

function runCaseBattle(lobby, p2Id, p2Name, p2Rank) {
    const tier = CASE_TIERS_SERVER.find(t => t.id === lobby.caseId) || CASE_TIERS_SERVER[0];
    const t1 = serverGetRandomTag(tier.tags), t2 = serverGetRandomTag(tier.tags);
    io.emit('case_battle_start', {
        lobbyId: lobby.id, caseId: lobby.caseId,
        player1Id: lobby.creatorId, player1Name: lobby.creatorName, player1TagId: t1.id, player1Rank: lobby.creatorRank || null,
        player2Id: p2Id, player2Name: p2Name, player2TagId: t2.id, player2Rank: p2Rank || null,
        winnerId: t1.value >= t2.value ? lobby.creatorId : p2Id
    });
    caseLobbies = caseLobbies.filter(l => l.id !== lobby.id);
}

function generateCrashPoint() {
    if (forcedCrashTarget !== null) { const v = forcedCrashTarget; forcedCrashTarget = null; console.log(`[ADMIN] Forced crash: ${v}x`); return v; }
    const e = 2 ** 32, h = crypto.randomBytes(4).readUInt32LE(0);
    if (h % 100 === 0) return 1.00;
    return Math.max(1.01, parseFloat((Math.max(1.00, (100 * e - h) / (e - h)) / 100).toFixed(2)));
}

function startCrashGameLoop() {
    crashState = 'WAITING'; crashTimer = 10; crashMultiplier = 1.0;
    io.emit('crash_state', { state: crashState, timer: crashTimer, multiplier: crashMultiplier });
    let w = setInterval(() => {
        crashTimer--;
        io.emit('crash_timer', { timer: crashTimer });
        if (crashTimer <= 0) { clearInterval(w); runCrashPhase(); }
    }, 1000);
}

function runCrashPhase() {
    crashState = 'RUNNING'; crashTarget = generateCrashPoint(); crashMultiplier = 1.0;
    io.emit('crash_state', { state: crashState, multiplier: crashMultiplier });
    let start = Date.now();
    crashInterval = setInterval(() => {
        crashMultiplier = Math.pow(Math.E, 0.00006 * (Date.now() - start));
        if (crashMultiplier >= crashTarget) {
            clearInterval(crashInterval); crashMultiplier = crashTarget; crashState = 'CRASHED';
            io.emit('crash_end', { multiplier: crashMultiplier });
            setTimeout(startCrashGameLoop, 5000);
        } else io.emit('crash_tick', { multiplier: crashMultiplier });
    }, 50);
}

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);
    socket.emit('chat_history', chatMessages);
    if (isChatMuted) socket.emit('new_chat_message', { author: 'SYSTEM', text: '🔒 Chat locked.', isOwner: true, time: Date.now() });
    socket.emit('crash_state', { state: crashState, timer: crashState === 'WAITING' ? crashTimer : null, multiplier: crashMultiplier });

    // Send current server state to new connections
    if (serverMode !== 'normal') socket.emit('server_mode_change', { mode: serverMode });
    if (globalMultiplier !== 1.0) socket.emit('global_multiplier_change', { value: globalMultiplier });

    // CHAT
    socket.on('send_chat', (data) => {
        if (isChatMuted && !data.isOwner) return;
        const author = data.author || 'User';
        if (bannedChatUsers.includes(author) && !data.isOwner) {
            socket.emit('new_chat_message', { author: 'SYSTEM', text: '🚫 You are banned from chat.', isOwner: true, time: Date.now() });
            return;
        }
        if (isSlowMode && !data.isOwner) {
            const now = Date.now(), last = slowModeCooldowns[author] || 0;
            if (now - last < 10000) {
                socket.emit('new_chat_message', { author: 'SYSTEM', text: `🐌 Slow mode: wait ${Math.ceil((10000-(now-last))/1000)}s`, isOwner: true, time: Date.now() });
                return;
            }
            slowModeCooldowns[author] = now;
        }
        const msg = { author, text: data.text || '', isOwner: !!data.isOwner, equippedRank: data.equippedRank || null, time: Date.now() };
        chatMessages.push(msg);
        if (chatMessages.length > MAX_MESSAGES) chatMessages.shift();
        io.emit('new_chat_message', msg);
    });

    // ADMIN
    socket.on('admin_command', (data) => {
        console.log('[ADMIN]', data.command);
        switch (data.command) {
            case 'clear_chat':
                chatMessages.length = 0; io.emit('chat_history', []);
                const cm = { author: 'SYSTEM', text: '🧹 Chat cleared.', isOwner: true, time: Date.now() };
                chatMessages.push(cm); io.emit('new_chat_message', cm);
                break;
            case 'toggle_mute':
                isChatMuted = !isChatMuted;
                const mm = { author: 'SYSTEM', text: `Chat ${isChatMuted ? 'LOCKED 🔒' : 'UNLOCKED 🔓'}`, isOwner: true, time: Date.now() };
                chatMessages.push(mm); io.emit('new_chat_message', mm);
                break;
            case 'set_slow_mode':
                isSlowMode = !!data.enabled;
                const sm = { author: 'SYSTEM', text: `🐌 Slow mode ${isSlowMode ? 'ON (10s)' : 'OFF'}`, isOwner: true, time: Date.now() };
                chatMessages.push(sm); io.emit('new_chat_message', sm);
                break;
            case 'ban_user':
                if (data.username && !bannedChatUsers.includes(data.username)) {
                    bannedChatUsers.push(data.username);
                    const bm = { author: 'SYSTEM', text: `🚫 ${data.username} banned.`, isOwner: true, time: Date.now() };
                    chatMessages.push(bm); io.emit('new_chat_message', bm);
                }
                break;
            case 'unban_user':
                bannedChatUsers = bannedChatUsers.filter(u => u !== data.username);
                const um = { author: 'SYSTEM', text: `✅ ${data.username} unbanned.`, isOwner: true, time: Date.now() };
                chatMessages.push(um); io.emit('new_chat_message', um);
                break;
            case 'set_mode':
                serverMode = data.mode || 'normal';
                io.emit('server_mode_change', { mode: serverMode });
                console.log('[ADMIN] Mode:', serverMode);
                break;
            case 'set_multiplier':
                globalMultiplier = parseFloat(data.value) || 1.0;
                io.emit('global_multiplier_change', { value: globalMultiplier });
                console.log('[ADMIN] Multiplier:', globalMultiplier);
                break;
            case 'force_crash':
                forcedCrashTarget = data.target !== null ? parseFloat(data.target) : null;
                console.log('[ADMIN] Force crash:', forcedCrashTarget || 'RANDOM');
                break;
            case 'rain_coins':
                io.emit('rain_received', { amount: data.amount || 0 });
                break;
            case 'gift_coins':
    io.emit('gift_notification', { 
        targetUsername: data.targetUsername, 
        targetId: data.targetId, 
        amount: data.amount,
        senderName: data.senderName || 'Admin'
    });
    break;
        }
    });

    socket.on('global_announcement', (data) => {
        const msg = { author: '📢 ANNOUNCEMENT', text: data.text || '', isOwner: true, time: Date.now() };
        chatMessages.push(msg); if (chatMessages.length > MAX_MESSAGES) chatMessages.shift();
        io.emit('new_chat_message', msg); io.emit('global_announcement', { text: data.text });
    });

    socket.on('crash_place_bet', (data) => socket.broadcast.emit('crash_live_bet', data));
    socket.on('crash_cashout', (data) => socket.broadcast.emit('crash_live_cashout', data));
    socket.on('donation_sent', (data) => io.emit('donation_received', data));

    socket.on('case_get_lobbies', () => socket.emit('case_lobby_list', caseLobbies));
    socket.on('case_create_lobby', (data) => {
        const lobby = { id: crypto.randomUUID(), creatorId: data.creatorId, creatorName: data.creatorName, creatorRank: data.creatorRank || null, caseId: data.caseId, cost: data.cost, socketId: socket.id, createdAt: Date.now() };
        caseLobbies.push(lobby); io.emit('case_lobby_created', lobby);
    });
    socket.on('case_cancel_lobby', (data) => { caseLobbies = caseLobbies.filter(l => l.id !== data.lobbyId); io.emit('case_lobby_removed', data.lobbyId); });
    socket.on('case_join_lobby', (data) => {
        const lobby = caseLobbies.find(l => l.id === data.lobbyId);
        if (!lobby) { socket.emit('case_lobby_removed', data.lobbyId); return; }
        if (lobby.creatorId === data.joinerId) return;
        runCaseBattle(lobby, data.joinerId, data.joinerName, data.joinerRank || null);
    });
    socket.on('case_bot_join', (data) => { const l = caseLobbies.find(x => x.id === data.lobbyId); if (l) runCaseBattle(l, 'bot', '🤖 Bot', null); });
    socket.on('disconnect', () => {
        caseLobbies.filter(l => l.socketId === socket.id).forEach(l => io.emit('case_lobby_removed', l.id));
        caseLobbies = caseLobbies.filter(l => l.socketId !== socket.id);
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => { console.log(`AstraRise on port ${PORT}`); startCrashGameLoop(); });

