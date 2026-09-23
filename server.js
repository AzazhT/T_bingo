const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
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
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 📌 የእርስዎ ትክክለኛ መረጃዎች (ቶክን እና ሊንኮች)
const TOKEN = '8698997396:AAEtZYRICBruFiUq5Hrs5HHgSA82qf0Hq7s';
const ADMIN_CHAT_ID = '686733543';
const WEB_APP_URL = 'https://t-bingo.onrender.com';             

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

app.post('/api/update-phone', async (req, res) => {
    const { identifier, phone } = req.body;
    try {
        await pool.query('UPDATE users SET phone = $1 WHERE identifier = $2', [phone, identifier]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
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

        if (bot && ADMIN_CHAT_ID) {
            try {
                const userRes = await pool.query('SELECT name, username, phone FROM users WHERE identifier = $1', [identifier]);
                let userInfo = userRes.rows[0] || {};
                
                let msgText = `🔔 **አዲስ የ ${type} ጥያቄ ገብቷል!**\n` +
                              `🆔 TxID: ${tx_id}\n` +
                              `👤 ስም: ${userInfo.name || 'Unknown'} (@${userInfo.username || 'none'})\n` +
                              `🆔 **Telegram ID:** \`${identifier}\`\n` +
                              `📱 ስልክ: ${userInfo.phone || 'N/A'}\n` +
                              `💰 መጠን: ${amount} ብር\n` +
                              `📝 መረጃ/ደረሰኝ: ${details || 'N/A'}`;

                await bot.sendMessage(ADMIN_CHAT_ID, msgText, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ አረጋግጥ (Approve)', callback_data: `approve_${tx_id}_${identifier}_${amount}_${type}` },
                                { text: '❌ ሰርዝ (Reject)', callback_data: `reject_${tx_id}_${identifier}_${amount}_${type}` }
                            ]
                        ]
                    }
                });
            } catch (notifyErr) {
                console.error('Failed to send instant admin notification:', notifyErr);
            }
        }

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
        { command: 'play', description: '🎮 Play Bingo (ጨዋታውን ክፈት)' },
        { command: 'balance', description: '💰 ቀሪ ሂሳብዎን ለማየት' },
        { command: 'deposit', description: '💳 የዲፖዚት መመሪያ' },
        { command: 'withdraw', description: '💸 ገንዘብ ወጪ ለማድረግ' },
        { command: 'admin', description: '👑 አድሚን ዳሽቦርድ' }
    ]);

    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const name = msg.from.first_name || 'ተጫዋች';
        
        let welcomeCaption = `✨ **እንኳን ወደ ዋና ቢንጎ በደህና መጡ!** ✨\n\n` +
                             `ሰላም **${name}**! 👋\n\n` +
                             `🎁 **የ 50 ብር ነፃ ቦነስ ስጦታዎን ተጠቅመው መጫወት ይጀምሩ!**\n` +
                             `🎯 **እየተዝናኑ እድልዎን ይፈትሹ!**`;

        const inlineButtons = {
            inline_keyboard: [
                [{ text: '🎲 ጨዋታውን ጀምር (Play Bingo) 🚀', web_app: { url: WEB_APP_URL } }],
                [
                    { text: '💳 Deposit', callback_data: 'btn_deposit' },
                    { text: '💸 Withdraw', callback_data: 'btn_withdraw' }
                ]
            ]
        };

        bot.sendMessage(chatId, welcomeCaption, {
            parse_mode: 'Markdown',
            reply_markup: inlineButtons
        });
    });

    bot.onText(/\/play/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, `🎮 የቢንጎ ጨዋታውን ለመጀመር ከታች ያለውን ቁልፍ ይጫኑ፡`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🚀 Play Bingo Web App 🎮', web_app: { url: WEB_APP_URL } }]
                ]
            }
        });
    });

    bot.onText(/\/admin/, async (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== ADMIN_CHAT_ID) return bot.sendMessage(chatId, 'ይህንን ትዕዛዝ መጠቀም የሚችሉት አድሚኖች ብቻ ናቸው!');

        try {
            const usersRes = await pool.query('SELECT COUNT(*) FROM users');
            const totalUsers = usersRes.rows[0].count;

            const balanceRes = await pool.query('SELECT SUM(balance) FROM users');
            const totalBalance = balanceRes.rows[0].sum || 0;

            bot.sendMessage(chatId, `👑 **የአድሚን ዳሽቦርድ**\n\n👥 ጠቅላላ ተጫዋቾች: ${totalUsers}\n💰 ጠቅላላ ባላንስ: ${totalBalance} ብር`, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error(err);
        }
    });

    bot.on('callback_query', async (callbackQuery) => {
        const action = callbackQuery.data;
        const msg = callbackQuery.message;
        const chatId = msg.chat.id;

        if (action === 'btn_deposit') {
            await bot.answerCallbackQuery(callbackQuery.id);
            return bot.sendMessage(chatId, `💳 **የዲፖዚት መመሪያ**\n\nበቴሌብር (0901494600) ገንዘብ ገቢ በማድረግ በዌብሳይቱ በኩል የዲፖዚት ጥያቄ ይላኩ።`, { parse_mode: 'Markdown' });
        }

        if (action === 'btn_withdraw') {
            await bot.answerCallbackQuery(callbackQuery.id);
            return bot.sendMessage(chatId, `💸 **ገንዘብ ወጪ ማድረጊያ (Withdraw)**\n\nያሸነፉትን ገንዘብ ወጪ ለማድረግ ዌብሳይቱን ይጠቀሙ።`, { parse_mode: 'Markdown' });
        }

        const parts = action.split('_');
        const status = parts[0]; 
        const tx_id = parts[1];
        const identifier = parts[2];
        const amount = parseFloat(parts[3]);
        const type = parts[4]; 

        try {
            if (status === 'approve') {
                if (type === 'DEPOSIT') {
                    const userRes = await pool.query('SELECT balance FROM users WHERE identifier = $1', [identifier]);
                    if (userRes.rows.length > 0) {
                        let currentBal = parseFloat(userRes.rows[0].balance);
                        let newBal = currentBal + amount;
                        await pool.query('UPDATE users SET balance = $1 WHERE identifier = $2', [newBal, identifier]);
                    }
                }
                await pool.query('UPDATE transactions SET handled = TRUE WHERE tx_id = $1', [tx_id]);

                await bot.editMessageText(`✅ **ይህ ጥያቄ (${tx_id}) በአድሚኑ ጸድቋል (Approved)!**`, {
                    chat_id: msg.chat.id,
                    message_id: msg.message_id,
                    parse_mode: 'Markdown'
                });

                try {
                    await bot.sendMessage(identifier, `🎉 **መልካም ዜና!** የ ${tx_id} የ ${type} ጥያቄዎ ${amount} ብር ፀድቋል።`, { parse_mode: 'Markdown' });
                } catch (e) {}

            } else if (status === 'reject') {
                if (type === 'WITHDRAW') {
                    const userRes = await pool.query('SELECT balance FROM users WHERE identifier = $1', [identifier]);
                    if (userRes.rows.length > 0) {
                        let currentBal = parseFloat(userRes.rows[0].balance);
                        let newBal = currentBal + amount;
                        await pool.query('UPDATE users SET balance = $1 WHERE identifier = $2', [newBal, identifier]);
                    }
                }
                await pool.query('UPDATE transactions SET handled = TRUE WHERE tx_id = $1', [tx_id]);

                await bot.editMessageText(`❌ **ይህ ጥያቄ (${tx_id}) ተሰርዟል (Rejected)!**`, {
                    chat_id: msg.chat.id,
                    message_id: msg.message_id,
                    parse_mode: 'Markdown'
                });

                try {
                    await bot.sendMessage(identifier, `❌ የ ${tx_id} የ ${type} ጥያቄዎ አልፀደቀም።`, { parse_mode: 'Markdown' });
                } catch (e) {}
            }
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'ተከናውኗል!' });
        } catch (err) {
            console.error('Error handling callback query:', err);
            bot.answerCallbackQuery(callbackQuery.id, { text: 'ስህተት ተፈጥሯል!' });
        }
    });
}

// ==========================================
// 🎲 CONTINUOUS GAME & SOCKET.IO
// ==========================================

let activeRooms = {}; 

function getActivePlayersCount(room) {
    let activeSocketIds = new Set();
    for (let bNum in room.selectedBoards) {
        if (room.selectedBoards[bNum]) {
            activeSocketIds.add(room.selectedBoards[bNum]);
        }
    }
    for (let socketId of room.players) {
        activeSocketIds.add(socketId);
    }
    return activeSocketIds.size;
}

function calculatePrizePool(room) {
    let activeCount = getActivePlayersCount(room);
    let totalBet = activeCount * parseFloat(room.betAmount);
    let commissionRate = 0.10; 
    let prizePool = totalBet * (1 - commissionRate);
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
            tempSelections: {},  
            drawnNumbers: [],
            countdown: 30,
            startTime: Date.now() + 30000,
            timer: null,
            gameInterval: null
        };
        startGlobalLobbyCountdown(roomId);
    }
    return activeRooms[roomId];
}

function resetRoomForNextGame(roomId) {
    let room = activeRooms[roomId];
    if (!room) return;

    room.drawnNumbers = [];
    room.reservedNumbers = {};
    room.selectedBoards = {}; 
    room.tempSelections = {};
    room.status = 'waiting';
    room.countdown = 30;
    room.startTime = Date.now() + 30000;

    io.to(roomId).emit('roomResetForNextRound', {
        status: room.status,
        countdown: room.countdown,
        startTime: room.startTime,
        selectedBoards: room.selectedBoards
    });

    startGlobalLobbyCountdown(roomId);
}

function startGlobalLobbyCountdown(roomId) {
    let room = activeRooms[roomId];
    if (!room) return;

    if (room.timer) clearInterval(room.timer);

    room.timer = setInterval(() => {
        if (room.status !== 'waiting') return;

        room.countdown--;

        let currentPrizePool = calculatePrizePool(room);

        io.to(roomId).emit('countdownUpdate', { 
            countdown: room.countdown, 
            status: room.status,
            playersCount: room.players.size,
            activePlayersCount: getActivePlayersCount(room),
            prizePool: currentPrizePool,
            startTime: room.startTime
        });

        if (room.countdown <= 0) {
            let selectedBoardsCount = Object.keys(room.selectedBoards).length;

            if (room.players.size < 1 || selectedBoardsCount < 1) {
                room.countdown = 30;
                room.startTime = Date.now() + 30000;
            } else {
                startRoomGame(roomId);
            }
        }
    }, 1000);
}

function startRoomGame(roomId) {
    let room = activeRooms[roomId];
    if (!room) return;

    room.status = 'playing';
    if (room.timer) clearInterval(room.timer);
    
    let finalPrizePool = calculatePrizePool(room);
    io.to(roomId).emit('gameStarted', { 
        message: 'ጨዋታው ተጀምሯል!',
        prizePool: finalPrizePool,
        status: room.status
    });

    room.gameInterval = setInterval(() => {
        if (room.drawnNumbers.length >= 75) {
            clearInterval(room.gameInterval);
            room.status = 'ended';
            io.to(roomId).emit('gameOver', { message: 'ጨዋታው አልቋል! 75ቱ ቁጥሮች ተጠርተዋል አሸናፊ አልተገኘም።' });
            setTimeout(() => {
                resetRoomForNextGame(roomId);
            }, 3000);
            return;
        }

        let rand;
        do {
            rand = Math.floor(Math.random() * 75) + 1;
        } while (room.drawnNumbers.includes(rand));

        room.drawnNumbers.push(rand);
        io.to(roomId).emit('numberDrawn', { number: rand, drawnHistory: room.drawnNumbers });
    }, 3000);
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('joinLobby', (data) => {
        const betAmount = data && data.betAmount ? data.betAmount : '20';
        let room = getOrCreateLobby(betAmount);

        socket.join(room.roomId);
        room.players.add(socket.id);
        socket.currentRoomId = room.roomId;

        let currentPrizePool = calculatePrizePool(room);

        socket.emit('assignedRoom', { 
            roomId: room.roomId, 
            betAmount: room.betAmount,
            countdown: room.countdown,
            startTime: room.startTime,
            status: room.status,
            reservedNumbers: room.reservedNumbers,
            selectedBoards: room.selectedBoards,
            activePlayersCount: getActivePlayersCount(room),
            prizePool: currentPrizePool
        });
        
        io.to(room.roomId).emit('playersUpdate', { 
            playersCount: room.players.size,
            activePlayersCount: getActivePlayersCount(room),
            prizePool: currentPrizePool
        });
    });

    socket.on('startPlayerGame', (data) => {
        const { roomId, boardNumber, name } = data;
        let room = activeRooms[roomId];

        if (room && room.status === 'waiting') {
            if (room.selectedBoards[boardNumber]) {
                return socket.emit('boardSelectError', { message: 'ይህ ቦርድ ቁጥር አስቀድሞ በሌላ ተጫዋች ተይዟል!' });
            }

            room.selectedBoards[boardNumber] = socket.id;
            room.playerNames[socket.id] = name || 'Player';
            
            let currentPrizePool = calculatePrizePool(room);

            io.to(roomId).emit('boardSelected', { boardNumber, socketId: socket.id });
            socket.emit('gameJoinSuccess', { boardNumber, prizePool: currentPrizePool });
        }
    });

    socket.on('claimBingo', async (data) => {
        const { roomId, identifier, winAmount } = data;
        let room = activeRooms[roomId];
        
        if (room && room.status === 'playing') {
            room.status = 'ended';
            if (room.gameInterval) clearInterval(room.gameInterval);
            if (room.timer) clearInterval(room.timer);

            let finalWinAmount = calculatePrizePool(room) || winAmount;

            try {
                if (identifier) {
                    const userRes = await pool.query('SELECT balance FROM users WHERE identifier = $1', [identifier]);
                    if (userRes.rows.length > 0) {
                        let newBal = parseFloat(userRes.rows[0].balance) + parseFloat(finalWinAmount);
                        await pool.query('UPDATE users SET balance = $1 WHERE identifier = $2', [newBal, identifier]);
                    }
                }
            } catch (err) {
                console.error('Balance update error on win:', err);
            }

            io.to(roomId).emit('gameOver', { 
                message: `🎉 ተጫዋች BINGO አሸንፏል! ${finalWinAmount} ብር ተሸልሟል።`,
                winAmount: finalWinAmount
            });

            setTimeout(() => {
                resetRoomForNextGame(roomId);
            }, 3000);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        for (let roomId in activeRooms) {
            let room = activeRooms[roomId];
            if (room.players.has(socket.id)) {
                room.players.delete(socket.id);
                delete room.playerNames[socket.id];

                let boardReleasedFlag = false;
                if (room.status === 'waiting') {
                    for (let bNum in room.selectedBoards) {
                        if (room.selectedBoards[bNum] === socket.id) {
                            delete room.selectedBoards[bNum];
                            boardReleasedFlag = true;
                            io.to(roomId).emit('boardReleased', { boardNumber: bNum });
                        }
                    }
                }

                let currentPrizePool = calculatePrizePool(room);
                io.to(room.roomId).emit('playersUpdate', { 
                    playersCount: room.players.size,
                    activePlayersCount: getActivePlayersCount(room),
                    prizePool: currentPrizePool
                });
            }
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, `0.0.0.0`, () => {
    console.log(`Server running on port ${PORT}`);
});
