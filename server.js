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

app.get('/api/admin/user/:identifier', async (req, res) => {
    const { identifier } = req.params;
    try {
        const userRes = await pool.query(`
            SELECT identifier, name, username, phone, balance 
            FROM users 
            WHERE identifier = $1
        `, [identifier]);

        if (userRes.rows.length === 0) {
            return res.json({ success: false, message: 'ተጠቃሚው አልተገኘም!' });
        }

        res.json({ 
            success: true, 
            user: userRes.rows[0] 
        });
    } catch (err) {
        console.error('Error fetching single user:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
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
        { command: 'broadcast', description: '📢 ለሁሉም ተጠቃሚዎች መልዕክት መላኪያ (Admin Only)' },
        { command: 'cancel', description: '❌ ሂደቱን ሰርዝ' }
    ]);

    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== ADMIN_CHAT_ID.toString()) return;

        const broadcastMessage = match[1];

        try {
            const usersRes = await pool.query('SELECT identifier FROM users');
            const allUsers = usersRes.rows;

            if (allUsers.length === 0) {
                return bot.sendMessage(chatId, '❌ በዳታቤዝ ውስጥ ምንም ተጠቃሚ አልተገኘም።');
            }

            let successCount = 0;
            let failCount = 0;

            bot.sendMessage(chatId, `⏳ መልዕክቱ ወደ **${allUsers.length}** ተጠቃሚዎች መላክ ተጀምሯል...`, { parse_mode: 'Markdown' });

            const playButton = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🎲 Play Bingo (አሁኑኑ ተጫወቱ) 🚀', web_app: { url: WEB_APP_URL } }]
                    ]
                }
            };

            for (const user of allUsers) {
                try {
                    await bot.sendMessage(user.identifier, broadcastMessage, { 
                        parse_mode: 'Markdown',
                        ...playButton
                    });
                    successCount++;
                } catch (err) {
                    failCount++;
                }
            }

            bot.sendMessage(chatId, 
                `✅ **መልዕክቱ ተልኮ አብቅቷል!**\n\n` +
                `📊 **ማጠቃለያ፦**\n` +
                `🎯 በተሳካ ሁኔታ የደረሳቸው፡ **${successCount}**\n` +
                `❌ ያልደረሳቸው (Block ያደረጉ)፡ **${failCount}**`, 
                { parse_mode: 'Markdown' }
            );

        } catch (err) {
            console.error('Broadcast Error:', err);
            bot.sendMessage(chatId, '❌ መልዕክቱ ሲላክ ስህተት ተፈጥሯል።');
        }
    });

    bot.onText(/\/user (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== ADMIN_CHAT_ID.toString()) return;

        const targetId = match[1].trim();

        try {
            const userRes = await pool.query('SELECT name, username, identifier, phone, balance FROM users WHERE identifier = $1', [targetId]);
            
            if (userRes.rows.length === 0) {
                return bot.sendMessage(chatId, `❌ ID \`${targetId}\` ያለው ተጠቃሚ አልተገኘም!`, { parse_mode: 'Markdown' });
            }

            const u = userRes.rows[0];
            let userMsg = `👤 **የተጠቃሚው መረጃ፦**\n\n` +
                          `👤 **ስም:** ${u.name || 'Unknown'}\n` +
                          `💬 **Username:** @${u.username || 'none'}\n` +
                          `🆔 **ID:** \`${u.identifier}\`\n` +
                          `📱 **ስልክ:** ${u.phone || 'ያልተመዘገበ'}\n` +
                          `💰 **ባላንስ:** ${u.balance} ETB`;

            bot.sendMessage(chatId, userMsg, { parse_mode: 'Markdown' });
        } catch (e) {
            bot.sendMessage(chatId, 'መረጃውን ማግኘት አልተቻለም።');
        }
    });

    bot.onText(/\/addbalance (\d+) (\d+(\.\d+)?)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== ADMIN_CHAT_ID.toString()) return;

        const targetUserIdentifier = match[1];
        const amountToAdd = parseFloat(match[2]);

        try {
            const userRes = await pool.query('SELECT name, balance FROM users WHERE identifier = $1', [targetUserIdentifier]);
            if (userRes.rows.length === 0) {
                return bot.sendMessage(chatId, `❌ ID \`${targetUserIdentifier}\` ያለው ተጠቃሚ አልተገኘም!`, { parse_mode: 'Markdown' });
            }

            let newBalance = parseFloat(userRes.rows[0].balance) + amountToAdd;
            await pool.query('UPDATE users SET balance = $1 WHERE identifier = $2', [newBalance, targetUserIdentifier]);

            bot.sendMessage(chatId, `✅ የ **${userRes.rows[0].name}** ባላንስ በ **+${amountToAdd}** ብር ጨምሯል።\n💰 አዲስ ባላንስ፦ **${newBalance}** ETB`, { parse_mode: 'Markdown' });

            try {
                await bot.sendMessage(targetUserIdentifier, `🎁 **${amountToAdd} ብር** ወደ ባላንስዎ ተጨምሯል! \n💰 የአሁኑ ባላንስዎ፦ **${newBalance}** ETB`, { parse_mode: 'Markdown' });
            } catch (e) {}

        } catch (err) {
            console.error(err);
            bot.sendMessage(chatId, 'ባላንስ በሚቀየርበት ጊዜ ስህተት ተፈጥሯል።');
        }
    });

    bot.onText(/\/deductbalance (\d+) (\d+(\.\d+)?)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== ADMIN_CHAT_ID.toString()) return;

        const targetUserIdentifier = match[1];
        const amountToDeduct = parseFloat(match[2]);

        try {
            const userRes = await pool.query('SELECT name, balance FROM users WHERE identifier = $1', [targetUserIdentifier]);
            if (userRes.rows.length === 0) {
                return bot.sendMessage(chatId, `❌ ID \`${targetUserIdentifier}\` ያለው ተጠቃሚ አልተገኘም!`, { parse_mode: 'Markdown' });
            }

            let currentBalance = parseFloat(userRes.rows[0].balance);
            let newBalance = currentBalance - amountToDeduct;
            if (newBalance < 0) newBalance = 0;

            await pool.query('UPDATE users SET balance = $1 WHERE identifier = $2', [newBalance, targetUserIdentifier]);

            bot.sendMessage(chatId, `📉 የ **${userRes.rows[0].name}** ባላንስ በ **-${amountToDeduct}** ብር ተቀንሷል።\n💰 አዲስ ባላንስ፦ **${newBalance}** ETB`, { parse_mode: 'Markdown' });

        } catch (err) {
            console.error(err);
            bot.sendMessage(chatId, 'ባላንስ በሚቀየርበት ጊዜ ስህተት ተፈጥሯል።');
        }
    });

    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const name = msg.from.first_name || 'ተጫዋች';
        delete userStates[chatId];
        
        let welcomeCaption = `✨ **እንኳን ወደ እድል ቢንጎ በደህና መጡ!** ✨\n\n` +
                             `ሰላም **${name}**! 👋\n\n` +
                             `🎁 **የ 50 ብር ነፃ ቦነስ ስጦታዎን ተጠቅመው መጫወት ይጀምሩ!**\n` +
                             `🎯 **እየተዝናኑ እድልዎን ይፈትሹ፡ እሴትዎን ያሳድጉ!**\n\n` +
                             `👇 **ከታች ባሉት አማራጮች ጨዋታውን ይጀምሩ ወይም ሂሳብዎን ይሙሉ።**`;

        const inlineButtons = {
            inline_keyboard: [
                [{ text: '🎲 ጨዋታውን ጀምር (Play Bingo) 🚀', web_app: { url: WEB_APP_URL } }],
                [
                    { text: '💳 Deposit', callback_data: 'btn_deposit' },
                    { text: '💸 Withdraw', callback_data: 'btn_withdraw' }
                ],
                [
                    { text: 'Check Balance 💰', callback_data: 'btn_balance' },
                    { text: 'Contact Us 📞', callback_data: 'btn_contact' }
                ]
            ]
        };

        let keyboardRows = [
            [{ text: "📲 Share Contact", request_contact: true }]
        ];
        if (chatId.toString() === ADMIN_CHAT_ID.toString()) {
            keyboardRows.push([{ text: "👑 Admin Panel" }]);
        }

        const mainKeyboard = {
            reply_markup: {
                keyboard: keyboardRows,
                resize_keyboard: true
            }
        };

        bot.sendMessage(chatId, welcomeCaption, {
            parse_mode: 'Markdown',
            reply_markup: inlineButtons
        }).then(() => {
            bot.sendMessage(chatId, "መልካም ዕድል፦", mainKeyboard);
        });
    });

    bot.onText(/👑 Admin Panel/, async (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== ADMIN_CHAT_ID.toString()) return;

        try {
            const usersRes = await pool.query('SELECT name, username, identifier, phone, balance FROM users ORDER BY identifier DESC LIMIT 20');
            const totalCountRes = await pool.query('SELECT COUNT(*) FROM users');
            
            let totalUsers = totalCountRes.rows[0].count;
            let userListMsg = `👑 **የአድሚን መቆጣጠሪያ Dashboard**\n\n👥 **ጠቅላላ የተመዘገቡ ተጠቃሚዎች:** ${totalUsers}\n\n📋 **የመጨረሻዎቹ ተጠቃሚዎች ዝርዝር፡**\n\n`;

            usersRes.rows.forEach((u, index) => {
                userListMsg += `${index + 1}. **${u.name || 'Unknown'}** (@${u.username || 'none'})\n` +
                               `   🆔 ID: \`${u.identifier}\`\n` +
                               `   📱 ስልክ: ${u.phone || 'ያልተመዘገበ'}\n` +
                               `   💰 ባላንስ: ${u.balance} ETB\n-----------------------\n`;
            });

            bot.sendMessage(chatId, userListMsg, { parse_mode: 'Markdown' });
        } catch (e) {
            console.error('Admin Panel error:', e);
            bot.sendMessage(chatId, 'የተጠቃሚዎችን መረጃ ማግኘት አልተቻለም።');
        }
    });

    bot.on('contact', async (msg) => {
        const chatId = msg.chat.id;
        const identifier = chatId.toString();
        const phoneNumber = msg.contact.phone_number;
        const name = msg.from.first_name || 'Player';
        const username = msg.from.username || '';

        try {
            let userRes = await pool.query('SELECT * FROM users WHERE identifier = $1', [identifier]);
            if (userRes.rows.length === 0) {
                await pool.query('INSERT INTO users (identifier, name, username, balance, phone) VALUES ($1, $2, $3, $4, $5)', 
                    [identifier, name, username, 50.00, phoneNumber]);
            } else {
                await pool.query('UPDATE users SET phone = $1 WHERE identifier = $2', [phoneNumber, identifier]);
            }

            bot.sendMessage(chatId, `✅ **ስልክ ቁጥርዎ (${phoneNumber}) በተሳካ ሁኔታ ተመዝግቧል!**`, { parse_mode: 'Markdown' });

        } catch (err) {
            console.error('Error saving contact from bot:', err);
            bot.sendMessage(chatId, 'ስልክ ቁጥርዎን በመመዝገብ ላይ ስህተት ተፈጥሯል።');
        }
    });

    bot.onText(/\/cancel/, (msg) => {
        const chatId = msg.chat.id;
        delete userStates[chatId];
        bot.sendMessage(chatId, '❌ የነበረው ሂደት ተሰርዟል።');
    });

    bot.onText(/\/play|🎮 Play now 🎮/, (msg) => {
        const chatId = msg.chat.id;
        delete userStates[chatId];
        bot.sendMessage(chatId, `🎮 የቢንጎ ጨዋታውን ለመጀመር ከታች ያለውን ቁልፍ ይጫኑ፡`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🚀 Play Bingo Web App 🎮', web_app: { url: WEB_APP_URL } }]
                ]
            }
        });
    });

    bot.onText(/\/balance|Check Balance 💰/, async (msg) => {
        const chatId = msg.chat.id;
        delete userStates[chatId];
        const username = msg.from.username || '';
        
        try {
            const userRes = await pool.query('SELECT balance, name FROM users WHERE username = $1 OR identifier = $2', [username, chatId.toString()]);
            if (userRes.rows.length > 0) {
                let user = userRes.rows[0];
                bot.sendMessage(chatId, `👤 **ስም:** ${user.name}\n💰 **ቀሪ ባላንስዎ:** ${user.balance} ብር`, { parse_mode: 'Markdown' });
            } else {
                bot.sendMessage(chatId, `እባክዎ መጀመሪያ ዌብሳይቱ ላይ በመግባት አካውንት ይክፈቱ!`);
            }
        } catch (err) {
            console.error(err);
            bot.sendMessage(chatId, 'የሰርቨር ስህተት አጋጥሟል።');
        }
    });

    const triggerDeposit = (chatId) => {
        userStates[chatId] = { step: 'AWAITING_DEPOSIT_AMOUNT' };
        let depositMsg = `💳 **ገንዘብ ገቢ ማድረጊያ (Deposit)**\n\n` +
                         `ገንዘብ ገቢ ለማድረግ የሚከተለውን አካውንት ይጠቀሙ፦\n\n` +
                         `📱 **ቴሌብር (Telebirr):** 0901494600\n` +
                         `👤 **ስም:** Anisha \n\n` +
                         `💵 **እባክዎ ማስገባት የሚፈልጉትን የብር መጠን በቁጥር ይጻፉ፦**\n*(ለማቋረጥ /cancel ይበሉ)*`;
        bot.sendMessage(chatId, depositMsg, { parse_mode: 'Markdown' });
    };

    const triggerWithdraw = async (chatId) => {
        const identifier = chatId.toString();
        try {
            const userRes = await pool.query('SELECT balance FROM users WHERE identifier = $1', [identifier]);
            if (userRes.rows.length === 0) {
                return bot.sendMessage(chatId, 'እባክዎ መጀመሪያ ሚኒ አፑን ከፍተው ይመዝገቡ!');
            }

            let balance = parseFloat(userRes.rows[0].balance);
            if (balance <= 0) {
                return bot.sendMessage(chatId, `❌ **ቀሪ ባላንስዎ 0 ብር ነው።** ወጪ ማድረግ አይችሉም።`);
            }

            userStates[chatId] = { step: 'AWAITING_WITHDRAW_AMOUNT', balance };
            bot.sendMessage(chatId, `💸 **ገንዘብ ወጪ ማድረጊያ (Withdraw)**\n\n💰 **ያለዎት ባላንስ:** ${balance} ብር\n\nእባክዎ ወጪ ማድረግ የሚፈልጉትን የብር መጠን ያስገቡ፦\n*(ለማቋረጥ /cancel ይበሉ)*`, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error(err);
            bot.sendMessage(chatId, 'የሰርቨር ስህተት አጋጥሟል።');
        }
    };

    bot.onText(/\/deposit|Deposit/, (msg) => triggerDeposit(msg.chat.id));
    bot.onText(/\/withdraw|Withdraw/, (msg) => triggerWithdraw(msg.chat.id));

    bot.onText(/Contact Us 📞/, (msg) => {
        const chatId = msg.chat.id;
        delete userStates[chatId];
        let contactMsg = `📞 **እኛን ለማግኘት (Support)**\n\n` +
                 `ለማንኛውም ጥያቄ፣ አስተያየት ወይም የገንዘብ ገቢ/ወጪ እገዛ በአካል ያናግሩን፦\n\n` +
                 `💬 **ቴሌግራም አድሚን:** [አድሚኑን ያናግሩ](https://t.me/bingo_bot21)\n` +
                 `📱 **ስልክ ቁጥር:** +251901494600`;
        
        bot.sendMessage(chatId, contactMsg, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true 
        });
    });

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text ? msg.text.trim() : '';

        if (text.startsWith('/') || ['🎮 Play now 🎮', 'Check Balance 💰', 'Deposit', 'Withdraw', 'Contact Us 📞', '👑 Admin Panel'].includes(text)) {
            return;
        }

        const state = userStates[chatId];
        if (!state) return;

        const identifier = chatId.toString();

        if (state.step === 'AWAITING_DEPOSIT_AMOUNT') {
            const amount = parseFloat(text);
            if (isNaN(amount) || amount <= 0) {
                return bot.sendMessage(chatId, '❌ እባክዎ ትክክለኛ የብር መጠን በቁጥር ብቻ ያስገቡ!');
            }

            userStates[chatId] = { step: 'AWAITING_DEPOSIT_DETAILS', amount };
            return bot.sendMessage(chatId, `✅ መጠን: ${amount} ብር\n\nእባክዎ የክፍያ ማረጋገጫውን (የቴሌብር SMS መልዕክት) ኮፒ አድርገው ይላኩልን፦`);
        }

        if (state.step === 'AWAITING_DEPOSIT_DETAILS') {
            const amount = state.amount;
            const details = text;
            delete userStates[chatId];

            const tx_id = 'TX' + Math.floor(100000 + Math.random() * 900000);

            try {
                let userRes = await pool.query('SELECT * FROM users WHERE identifier = $1', [identifier]);
                if (userRes.rows.length === 0) {
                    const name = msg.from.first_name || 'Player';
                    const username = msg.from.username || '';
                    await pool.query('INSERT INTO users (identifier, name, username, balance) VALUES ($1, $2, $3, $4)', [identifier, name, username, 50.00]);
                }

                await pool.query(
                    'INSERT INTO transactions (tx_id, identifier, type, amount, details, handled) VALUES ($1, $2, $3, $4, $5, FALSE)',
                    [tx_id, identifier, 'DEPOSIT', amount, details]
                );

                bot.sendMessage(chatId, `✅ **የዲፖዚት ጥያቄዎ በተሳካ ሁኔታ ተልኳል!**\n\n🆔 **TxID:** ${tx_id}\n💰 **መጠን:** ${amount} ብር\n\nአድሚኑ መረጃውን አረጋግጦ በቅርቡ ባላንስዎ ላይ ይጨምራል።`, { parse_mode: 'Markdown' });

                if (ADMIN_CHAT_ID) {
                    const userInfo = msg.from;
                    let msgText = `🔔 **አዲስ የ DEPOSIT ጥያቄ (ከቦት ቻት)**\n` +
                                  `🆔 TxID: ${tx_id}\n` +
                                  `👤 ስም: ${userInfo.first_name || 'Unknown'} (@${userInfo.username || 'none'})\n` +
                                  `🆔 Telegram ID: \`${identifier}\`\n` +
                                  `💰 መጠን: ${amount} ብር\n` +
                                  `📝 መረጃ/ደረሰኝ: ${details}`;

                    await bot.sendMessage(ADMIN_CHAT_ID, msgText, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '✅ አረጋግጥ (Approve)', callback_data: `approve_${tx_id}_${identifier}_${amount}_DEPOSIT` },
                                    { text: '❌ ሰርዝ (Reject)', callback_data: `reject_${tx_id}_${identifier}_${amount}_DEPOSIT` }
                                ]
                            ]
                        }
                    });
                }
            } catch (err) {
                console.error(err);
                bot.sendMessage(chatId, 'የዲፖዚት ጥያቄ ሲላክ ስህተት ተፈጥሯል።');
            }
            return;
        }

        if (state.step === 'AWAITING_WITHDRAW_AMOUNT') {
            const amount = parseFloat(text);
            if (isNaN(amount) || amount <= 0) {
                return bot.sendMessage(chatId, '❌ እባክዎ ትክክለኛ የብር መጠን በቁጥር ብቻ ያስገቡ!');
            }

            if (amount > state.balance) {
                return bot.sendMessage(chatId, `❌ **አይችሉም!** አስገቡት መጠን (${amount} ብር) ካለዎት ባላንስ (${state.balance} ብር) ይበልጣል።`);
            }

            userStates[chatId] = { step: 'AWAITING_WITHDRAW_DETAILS', amount };
            return bot.sendMessage(chatId, `✅ መጠን: ${amount} ብር\n\nእባክዎ ገንዘቡ እንዲላክሎት የሚፈልጉበትን **የባንክ ስም፣ የአካውንት ቁጥር እና የስም** ያስገቡ፦`);
        }

        if (state.step === 'AWAITING_WITHDRAW_DETAILS') {
            const amount = state.amount;
            const details = text;
            delete userStates[chatId];

            const tx_id = 'TX' + Math.floor(100000 + Math.random() * 900000);

            try {
                const userRes = await pool.query('SELECT balance FROM users WHERE identifier = $1', [identifier]);
                if (userRes.rows.length === 0) return bot.sendMessage(chatId, 'ተጠቃሚው አልተገኘም!');

                let currentBalance = parseFloat(userRes.rows[0].balance);
                if (currentBalance < amount) {
                    return bot.sendMessage(chatId, '❌ በቂ ባላንስ የለዎትም!');
                }

                let newBalance = currentBalance - amount;
                await pool.query('UPDATE users SET balance = $1 WHERE identifier = $2', [newBalance, identifier]);

                await pool.query(
                    'INSERT INTO transactions (tx_id, identifier, type, amount, details, handled) VALUES ($1, $2, $3, $4, $5, FALSE)',
                    [tx_id, identifier, 'WITHDRAW', amount, details]
                );

                bot.sendMessage(chatId, `✅ **የወጪ ጥያቄዎ በተሳካ ሁኔታ ተልኳል!**\n\n🆔 **TxID:** ${tx_id}\n💰 **መጠን:** ${amount} ብር\n💰 **ቀሪ ባላንስ:** ${newBalance} ብር\n\nአድሚኑ አረጋግጦ በቅርቡ ወደ ገለጹት አካውንት ይልካል፤ ጥያቄው ካልፀደቀ ብሩ ወደ ባላንስዎ ይመለሳል።`, { parse_mode: 'Markdown' });

                if (ADMIN_CHAT_ID) {
                    const userInfo = msg.from;
                    let msgText = `🔔 **አዲስ የ WITHDRAW ጥያቄ (ከቦት ቻት)**\n` +
                                  `🆔 TxID: ${tx_id}\n` +
                                  `👤 ስም: ${userInfo.first_name || 'Unknown'} (@${userInfo.username || 'none'})\n` +
                                  `🆔 Telegram ID: \`${identifier}\`\n` +
                                  `💰 መጠን: ${amount} ብር\n` +
                                  `🏦 የከፋይ አካውንት: ${details}`;

                    await bot.sendMessage(ADMIN_CHAT_ID, msgText, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '✅ አረጋግጥ (Approve)', callback_data: `approve_${tx_id}_${identifier}_${amount}_WITHDRAW` },
                                    { text: '❌ ሰርዝ (Reject)', callback_data: `reject_${tx_id}_${identifier}_${amount}_WITHDRAW` }
                                ]
                            ]
                        }
                    });
                }
            } catch (err) {
                console.error(err);
                bot.sendMessage(chatId, 'የወጪ ጥያቄ ሲላክ ስህተት ተፈጥሯል።');
            }
            return;
        }
    });

    bot.on('callback_query', async (callbackQuery) => {
        const action = callbackQuery.data;
        const msg = callbackQuery.message;
        const chatId = msg.chat.id;

        if (action === 'btn_deposit') {
            await bot.answerCallbackQuery(callbackQuery.id);
            return triggerDeposit(chatId);
        }

        if (action === 'btn_withdraw') {
            await bot.answerCallbackQuery(callbackQuery.id);
            return triggerWithdraw(chatId);
        }

        if (action === 'btn_balance') {
            await bot.answerCallbackQuery(callbackQuery.id);
            try {
                const userRes = await pool.query('SELECT balance, name FROM users WHERE identifier = $1', [chatId.toString()]);
                if (userRes.rows.length > 0) {
                    let user = userRes.rows[0];
                    bot.sendMessage(chatId, `👤 **ስም:** ${user.name}\n💰 **ቀሪ ባላንስዎ:** ${user.balance} ብር`, { parse_mode: 'Markdown' });
                } else {
                    bot.sendMessage(chatId, `እባክዎ መጀመሪያ ዌብሳይቱ ላይ በመግባት አካውንት ይክፈቱ!`);
                }
            } catch (err) {
                console.error(err);
            }
            return;
        }

        if (action === 'btn_contact') {
            await bot.answerCallbackQuery(callbackQuery.id);
            let contactMsg = `📞 **እኛን ለማግኘት (Support)**\n\n` +
                              `ለማንኛውም ጥያቄ፣ አስተያየት ወይም የገንዘብ ገቢ/ወጪ እገዛ በአካል ያናግሩን፦\n\n` +
                              `💬 **ቴሌግራም አድሚን:** [አድሚኑን ያናግሩ](https://t.me/bingo_bot21)\n` +
                              `📱 **ስልክ ቁጥር:** +251901494600`;
            return bot.sendMessage(chatId, contactMsg, { 
                parse_mode: 'Markdown',
                disable_web_page_preview: true 
            });
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

const mixedTelegramNames = [
    "Henok", "Robel", "Dawit", "Yonas", "Elias", "Kebede", "Seleshi", "Nati", 
    "Kaleb", "Bereket", "Amanuel", "Yared", "Tewodros", "Girma", "Biniyam", "Sami",
    "Ermias", "Abebe", "Getachew", "Mulugeta", "Matiwos", "Surafel", "Dagi", "Fikru",
    "Bruk", "Kidus", "Abel", "Mikiyas", "Eyob", "Solomon", "Tinsae", "Nathanael",
    "Nahom", "Bisrat", "Gideon", "Kirubel", "Caleb", "Fitsum", "Samuel", "Yonatan",
    "Z", "H", "X", "K", "ZZ", "A", "M", "T", "AZ", "KX", "XX", "B", "S", "Y", "R", "D", "W", "J",
    "Hana", "Meti", "Ruta", "Saba", "Bethlehem", "Mahlet", "Meron", "Aster", 
    "Rahel", "Kalkidan", "Fikir", "Lydia", "Selam", "Tsion", "Eden", "Helen",
    "Henok.Z", "Robel_K", "D.A", "Yonas_Z", "H.M", "K.T", "A.B", "Z.X", "S.N"
];

function getRandomTelegramName() {
    const baseName = mixedTelegramNames[Math.floor(Math.random() * mixedTelegramNames.length)];
    if (Math.random() > 0.5) {
        return baseName;
    } else {
        const randomNum = Math.floor(1 + Math.random() * 99);
        return `${baseName}_${randomNum}`;
    }
}

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

        let totalPossibleBoards = 100;
        let targetBotSelections = Math.floor((30 - room.countdown) * 1.5); 
        let currentSelectedCount = Object.keys(room.selectedBoards).length;

        if (currentSelectedCount < targetBotSelections && currentSelectedCount < totalPossibleBoards) {
            let randomBoard;
            let attempts = 0;
            do {
                randomBoard = Math.floor(Math.random() * totalPossibleBoards) + 1;
                attempts++;
            } while (room.selectedBoards[randomBoard] && attempts < 20);

            if (!room.selectedBoards[randomBoard]) {
                let botId = `BOT_${Math.floor(Math.random() * 10000)}`;
                room.selectedBoards[randomBoard] = botId;
                
                room.playerNames[botId] = getRandomTelegramName();

                io.to(roomId).emit('boardSelected', { boardNumber: randomBoard, socketId: botId });
            }
        }

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

function findWinningLine(card, drawnNums) {
    let marked = Array(5).fill(false).map(() => Array(5).fill(false));
    marked[2][2] = true;

    for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
            let val = card[r][c];
            if (val === '*' || drawnNums.includes(val)) {
                marked[r][c] = true;
            }
        }
    }

    for(let r=0; r<5; r++) {
        if([0,1,2,3,4].every(c => marked[r][c])) return { type: 'row', index: r };
    }
    for(let c=0; c<5; c++) {
        if([0,1,2,3,4].every(r => marked[r][c])) return { type: 'col', index: c };
    }
    if([0,1,2,3,4].every(i => marked[i][i])) return { type: 'diag1', index: 0 };
    if([0,1,2,3,4].every(i => marked[i][4-i])) return { type: 'diag2', index: 0 };

    return null;
}

// 🎯 ማስተካከያ 1፦ የተስተካከለ የቦቶች የቢንጎ ካርድ አመራረት
function generateServerBingoCard() {
    let ranges = [[1,15], [16,30], [31,45], [46,60], [61,75]];
    let card = Array(5).fill(null).map(() => Array(5).fill(0));

    for (let c = 0; c < 5; c++) {
        let colNums = [];
        let min = ranges[c][0], max = ranges[c][1];
        while (colNums.length < 5) {
            let rand = Math.floor(Math.random() * (max - min + 1)) + min;
            if (!colNums.includes(rand)) colNums.push(rand);
        }
        for (let r = 0; r < 5; r++) {
            card[r][c] = (r === 2 && c === 2) ? "*" : colNums[r];
        }
    }
    return card;
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

    let roomBotCards = {};
    for (let bNum in room.selectedBoards) {
        let ownerId = room.selectedBoards[bNum];
        if (ownerId && ownerId.startsWith('BOT_')) {
            roomBotCards[ownerId] = { boardNumber: bNum, card: generateServerBingoCard() };
        }
    }

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

        for (let botId in roomBotCards) {
            let botData = roomBotCards[botId];
            let winningLine = findWinningLine(botData.card, room.drawnNumbers);
            if (winningLine) {
                clearInterval(room.gameInterval);
                if (room.timer) clearInterval(room.timer);
                room.status = 'ended';

                let botWinAmount = finalPrizePool;
                let botName = room.playerNames[botId] || getRandomTelegramName();

                io.to(roomId).emit('gameOver', { 
                    subtitle: '1 player has won the game',
                    winnerName: botName,
                    boardNumber: botData.boardNumber,
                    winAmount: botWinAmount,
                    winningLine: winningLine
                });

                setTimeout(() => {
                    resetRoomForNextGame(roomId);
                }, 3000);
                return;
            }
        }
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

    socket.on('selectBoardTemp', (data) => {
        const { roomId, boardNumber } = data;
        let room = activeRooms[roomId];

        if (room && room.status === 'playing') {
            return socket.emit('boardSelectError', { message: 'ጨዋታው በሂደት ላይ ስለሆነ አዲስ ቦርድ መምረጥ አይችሉም!' });
        }

        if (room && room.status === 'waiting') {
            if (room.selectedBoards[boardNumber]) {
                return socket.emit('boardSelectError', { message: 'ይህ ቦርድ ቁጥር አስቀድሞ በሌላ ተጫዋች ወይም በቦት ተይዟል!' });
            }

            if (!room.tempSelections) room.tempSelections = {};
            room.tempSelections[socket.id] = boardNumber;

            socket.emit('boardTempSelected', { boardNumber });
        }
    });

    socket.on('startPlayerGame', (data) => {
        const { roomId, boardNumber, name } = data;
        let room = activeRooms[roomId];

        if (room && room.status === 'playing') {
            return socket.emit('boardSelectError', { message: 'ጨዋታው በሂደት ላይ ስለሆነ አዲስ መግባት አይችሉም!' });
        }

        if (room && room.status === 'waiting') {
            if (room.selectedBoards[boardNumber]) {
                return socket.emit('boardSelectError', { message: 'ይህ ቦርድ ቁጥር አስቀድሞ በሌላ ተጫዋች ወይም በቦት ተይዟል!' });
            }

            let previousBoard = null;
            for (let bNum in room.selectedBoards) {
                if (room.selectedBoards[bNum] === socket.id) {
                    previousBoard = bNum;
                    delete room.selectedBoards[bNum];
                }
            }

            if (previousBoard) {
                io.to(roomId).emit('boardReleased', { boardNumber: previousBoard });
            }

            room.selectedBoards[boardNumber] = socket.id;
            room.playerNames[socket.id] = name || 'Player';

            if (room.tempSelections && room.tempSelections[socket.id]) {
                delete room.tempSelections[socket.id];
            }
            
            let currentPrizePool = calculatePrizePool(room);

            io.to(roomId).emit('boardSelected', { boardNumber, socketId: socket.id });
            io.to(roomId).emit('activePlayersUpdate', { 
                activePlayersCount: getActivePlayersCount(room),
                prizePool: currentPrizePool 
            });

            socket.emit('gameJoinSuccess', { boardNumber, prizePool: currentPrizePool });
        }
    });

    // 🎯 ማስተካከያ 2፦ እውነተኛ ተጫዋች ቢንጎ ቢል እንኳ ቦቱ እንዲያሸንፍ የማድረግ logic
    socket.on('claimBingo', async (data) => {
        const { roomId } = data;
        let room = activeRooms[roomId];
        
        if (room && room.status === 'playing') {
            room.status = 'ended';
            if (room.gameInterval) clearInterval(room.gameInterval);
            if (room.timer) clearInterval(room.timer);

            let finalWinAmount = calculatePrizePool(room);

            let botIds = Object.keys(room.selectedBoards).filter(id => id.startsWith('BOT_'));
            let winningBotId = botIds.length > 0 ? botIds[0] : `BOT_${Math.floor(Math.random() * 1000)}`;
            let botBoardNumber = Object.keys(room.selectedBoards).find(key => room.selectedBoards[key] === winningBotId) || "12";
            let botName = room.playerNames[winningBotId] || getRandomTelegramName();

            let fakeWinningLine = { type: 'row', index: 0 };

            io.to(roomId).emit('gameOver', { 
                subtitle: '1 player has won the game',
                winnerName: botName,
                boardNumber: botBoardNumber,
                winAmount: finalWinAmount,
                winningLine: fakeWinningLine
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
                
                if (room.tempSelections && room.tempSelections[socket.id]) {
                    delete room.tempSelections[socket.id];
                }

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

                if (boardReleasedFlag) {
                    io.to(room.roomId).emit('activePlayersUpdate', { 
                        activePlayersCount: getActivePlayersCount(room),
                        prizePool: currentPrizePool 
                    });
                }
            }
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, `0.0.0.0`, () => {
    console.log(`Server running on port ${PORT}`);
});
