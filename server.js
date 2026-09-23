const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const pool = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.json());
app.use(express.static('public'));

const TOKEN = '8957133551:AAF6Hs-LK2VbMO4wUM_ugLdMVbNFN5Bap90';
const ADMIN_CHAT_ID = '686733543';
const WEB_APP_URL = 'https://wana-bingo.onrender.com';

const userStates = {};

let bot = null;
if (TOKEN) {
    try {
        bot = new TelegramBot(TOKEN, {  
            polling: {
                interval: 300,
                autoStart: true,
                params: { timeout: 10 }
            } 
        });
        console.log('Telegram Bot started successfully!');
        bot.on('polling_error', (error) => {
            console.log(`Telegram Polling Error: ${error.code} - ${error.message}`);
        });
    } catch (err) {
        console.error('Telegram Bot initialization error:', err);
    }
} else {
    console.error('ERROR: Telegram Bot Token not provided!');
}

async function initializeDatabase() {
    try {
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='transactions' AND column_name='details') THEN
                    ALTER TABLE transactions ADD COLUMN details TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='phone') THEN
                    ALTER TABLE users ADD COLUMN phone TEXT;
                END IF;
            END $$;
        `);
        console.log('Database tables checked and updated.');
    } catch (err) {
        console.error('Database initialization warning:', err.message);
    }
}
initializeDatabase();

// ==========================================
// 🔹 API ENDPOINTS
// ==========================================

app.get('/api/admin/users', async (req, res) => {
    try {
        const usersRes = await pool.query(`
            SELECT identifier, name, username, phone, balance 
            FROM users 
            ORDER BY identifier DESC
        `);
        res.json({ 
            success: true, 
            totalUsers: usersRes.rows.length, 
            users: usersRes.rows 
        });
    } catch (err) {
        console.error('Error fetching admin users:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

app.post('/api/get-user', async (req, res) => {
    const { identifier, name, username } = req.body;
    try {
        let userRes = await pool.query('SELECT * FROM users WHERE identifier = $1', [identifier]);
        let user;
        if (userRes.rows.length === 0) {
            const INITIAL_BONUS = 50.00;
            const insertRes = await pool.query(
                'INSERT INTO users (identifier, name, username, balance) VALUES ($1, $2, $3, $4) RETURNING *',
                [identifier, name || 'Player', username || '', INITIAL_BONUS]
            );
            user = insertRes.rows[0];

            if (bot && identifier) {
                try {
                    await bot.sendMessage(identifier, `🎁 **እንኳን ደስ አለዎት!** የአዲስ ተጠቃሚ **50 ብር ነፃ ቦነስ** በስጦታ ወደ ባላንስዎ ተጨምሯል። መልካም እድል!`, { parse_mode: 'Markdown' });
                } catch (e) {}
            }
        } else {
            user = userRes.rows[0];
        }
        res.json({ success: true, user });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/place-bet', async (req, res) => {
    const { identifier, amount } = req.body;
    try {
        const userRes = await pool.query('SELECT balance FROM users WHERE identifier = $1', [identifier]);
        if (userRes.rows.length === 0) return res.json({ success: false, message: 'User not found' });
        
        let balance = parseFloat(userRes.rows[0].balance);
        if (balance < amount) return res.json({ success: false, message: 'በቂ ባላንስ የለዎትም!' });

        let newBalance = balance - amount;
        await pool.query('UPDATE users SET balance = $1 WHERE identifier = $2', [newBalance, identifier]);
        res.json({ success: true, newBalance });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/request-transaction', async (req, res) => {
    const { identifier, type, amount, details } = req.body;
    const tx_id = 'TX' + Math.floor(100000 + Math.random() * 900000);
    
    try {
        if (type === 'WITHDRAW') {
            const userRes = await pool.query('SELECT balance FROM users WHERE identifier = $1', [identifier]);
            if (userRes.rows.length === 0) {
                return res.json({ success: false, message: 'ተጠቃሚው አልተገኘም' });
            }
            let currentBalance = parseFloat(userRes.rows[0].balance);
            if (currentBalance < parseFloat(amount)) {
                return res.json({ success: false, message: 'በዋሌትዎ ውስጥ ያለው ብር በቂ አይደለም!' });
            }
            let newBalance = currentBalance - parseFloat(amount);
            await pool.query('UPDATE users SET balance = $1 WHERE identifier = $2', [newBalance, identifier]);
        }

        await pool.query(
            'INSERT INTO transactions (tx_id, identifier, type, amount, details, handled) VALUES ($1, $2, $3, $4, $5, FALSE)',
            [tx_id, identifier, type, amount, details || 'N/A']
        );

        res.json({ success: true, tx_id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'ሰርቨር ላይ ስህተት ተፈጥሯል' });
    }
});

// ==========================================
// 🤖 TELEGRAM BOT CHAT FLOW
// ==========================================

if (bot) {
    bot.setMyCommands([
        { command: 'start', description: 'ቦቱን ለመጀመር' },
        { command: 'play', description: '🎮 ጨዋታዎችን ለመክፈት' },
        { command: 'balance', description: '💰 ቀሪ ሂሳብዎን ለማየት' }
    ]);

    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const name = msg.from.first_name || 'ተጫዋች';
        
        let welcomeCaption = `✨ **እንኳን ወደ ጨዋታ ማዕከል በደህና መጡ!** ✨\n\n` +
                             `ሰላም **${name}**! 👋\n` +
                             `🎁 **የ 50 ብር ነፃ ቦነስ ተጠቅመው ቢንጎ ወይም ኬኖ መጫወት ይችላሉ!**`;

        const inlineButtons = {
            inline_keyboard: [
                [{ text: '🎲 ቢንጎ ጨዋታ (Play Bingo) 🚀', web_app: { url: `${WEB_APP_URL}/bingo.html` } }],
                [{ text: '🎯 ኬኖ ጨዋታ (Play Keno) 🚀', web_app: { url: `${WEB_APP_URL}/keno.html` } }],
                [
                    { text: '💳 Deposit', callback_data: 'btn_deposit' },
                    { text: '💸 Withdraw', callback_data: 'btn_withdraw' }
                ],
                [{ text: 'Check Balance 💰', callback_data: 'btn_balance' }]
            ]
        };

        bot.sendMessage(chatId, welcomeCaption, {
            parse_mode: 'Markdown',
            reply_markup: inlineButtons
        });
    });
}

// ==========================================
// 🎯 KENO GAME LOGIC & STATE
// ==========================================

let activeTickets = [];
let kenoDrawnNumbers = [];
let kenoTimerVal = 30;
let isKenoDrawing = false;

setInterval(() => {
    if (isKenoDrawing) return;

    kenoTimerVal--;
    io.emit('kenoTimerUpdate', { timerVal: kenoTimerVal });

    if (kenoTimerVal <= 0) {
        startKenoDrawSequence();
    }
}, 1000);

function startKenoDrawSequence() {
    isKenoDrawing = true;
    kenoDrawnNumbers = [];
    io.emit('kenoDrawStarted');

    let drawCount = 0;
    let interval = setInterval(() => {
        let rand = Math.floor(Math.random() * 80) + 1;
        if (!kenoDrawnNumbers.includes(rand)) {
            kenoDrawnNumbers.push(rand);
            drawCount++;

            io.emit('kenoNewDrawnNumber', { number: rand, count: drawCount, allDrawn: kenoDrawnNumbers });

            if (drawCount === 20) {
                clearInterval(interval);
                
                setTimeout(() => {
                    activeTickets = [];
                    kenoDrawnNumbers = [];
                    isKenoDrawing = false;
                    kenoTimerVal = 30;
                    io.emit('kenoGameReset');
                }, 5000);
            }
        }
    }, 700);
}

// ==========================================
// 🎲 BINGO GAME & SOCKET.IO (Combined)
// ==========================================

let activeRooms = {}; 

function getActivePlayersCount(room) {
    let activeSocketIds = new Set();
    for (let bNum in room.selectedBoards) {
        if (room.selectedBoards[bNum]) activeSocketIds.add(room.selectedBoards[bNum]);
    }
    for (let socketId of room.players) {
        activeSocketIds.add(socketId);
    }
    return activeSocketIds.size;
}

function calculatePrizePool(room) {
    let activeCount = getActivePlayersCount(room);
    let totalBet = activeCount * parseFloat(room.betAmount);
    let prizePool = totalBet * 0.90; 
    return Math.floor(prizePool > 0 ? prizePool : parseFloat(room.betAmount));
}

function getOrCreateLobby(betAmount) {
    let roomId = null;
    for (let id in activeRooms) {
        if (activeRooms[id].betAmount === betAmount) {
            roomId = id;
            break;
        }
    }

    if (!roomId) {
        let uniqueId = Math.floor(1000 + Math.random() * 9000);
        roomId = `ROOM_${betAmount}_${uniqueId}`;
        
        activeRooms[roomId] = {
            roomId,
            betAmount,
            status: 'waiting', 
            players: new Set(),
            playerNames: {},
            reservedNumbers: {}, 
            selectedBoards: {}, 
            drawnNumbers: [],
            countdown: 30,
            startTime: Date.now() + 30000,
            timer: null,
            gameInterval: null
        };
    }
    return activeRooms[roomId];
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Keno init data
    socket.emit('kenoInitData', { timerVal: kenoTimerVal, isDrawing: isKenoDrawing, activeTickets, drawnNumbers: kenoDrawnNumbers });

    socket.on('buyKenoTicket', (ticketData) => {
        if (isKenoDrawing) return;
        activeTickets.push(ticketData);
        io.emit('updateKenoTickets', activeTickets);
    });

    // Bingo events
    socket.on('joinLobby', (data) => {
        const betAmount = data && data.betAmount ? data.betAmount : '20';
        let room = getOrCreateLobby(betAmount);

        socket.join(room.roomId);
        room.players.add(socket.id);

        socket.emit('assignedRoom', { 
            roomId: room.roomId, 
            betAmount: room.betAmount,
            countdown: room.countdown,
            status: room.status,
            selectedBoards: room.selectedBoards,
            prizePool: calculatePrizePool(room)
        });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
