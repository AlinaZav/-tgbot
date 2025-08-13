const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 8000;
const TOKEN = process.env.TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ Нет переменных окружения TOKEN, SUPABASE_URL или SUPABASE_KEY!");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const bot = new TelegramBot(TOKEN);
const WEBHOOK_URL = `https://serious-leola-botpetr-c7d2426b.koyeb.app/bot${TOKEN}`;
bot.setWebHook(WEBHOOK_URL);

const ADMINS = [5202993972];
let acceptingRequests = true;
const userData = {};
const pendingRejections = {};
const activeRequests = {};

// === Функции для чека ===
async function checkExists(checkNumber) {
    const { data, error } = await supabase
        .from('checks')
        .select('id')
        .eq('check_number', checkNumber)
        .maybeSingle();

    if (error) {
        console.error("Ошибка проверки чека:", error);
        return false;
    }
    return !!data;
}

async function saveCheck(checkNumber) {
    const { error } = await supabase
        .from('checks')
        .insert([{ check_number: checkNumber }]);

    if (error) {
        console.error("Ошибка сохранения чека:", error);
        return false;
    }
    return true;
}

// === Блокировка заявки пользователя ===
function lockUserRequest(userId) {
    activeRequests[userId] = true;

    // Авторазблокировка через 10 минут
    setTimeout(() => {
        if (activeRequests[userId]) {
            delete activeRequests[userId];
            bot.sendMessage(userId, '⏳ Ваша заявка снята с ожидания из-за отсутствия ответа.');
        }
    }, 10 * 60 * 1000);
}

// === Обработка сообщений ===
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (pendingRejections[chatId]) {
        const targetUser = pendingRejections[chatId];
        bot.sendMessage(targetUser, `❌ Отказано: ${text}`);
        bot.sendMessage(chatId, 'Причина отказа отправлена.');
        delete pendingRejections[chatId];
        return;
    }

    if (activeRequests[chatId]) {
        bot.sendMessage(chatId, '⛔ Вы уже отправили заявку. Дождитесь ответа.');
        return;
    }

    if (!acceptingRequests && !ADMINS.includes(msg.from.id)) {
        bot.sendMessage(chatId, '⛔ Приём заявок закрыт.');
        return;
    }

    if (['Простой', 'Перепробег', 'Отказ от доставки'].includes(text)) {
        userData[chatId] = { type: text, step: 1 };
        bot.sendMessage(chatId, 'Введите дату закрытия рейса (ДД.ММ.ГГГГ):');
        return;
    }

    if (userData[chatId]) {
        const step = userData[chatId].step;
        const type = userData[chatId].type;

        if (step === 1) {
            userData[chatId].date = text;
            userData[chatId].step++;
            bot.sendMessage(chatId, 'Введите номер товарного чека:');
        } else if (step === 2) {
            const checkNumber = text.toUpperCase();
            const exists = await checkExists(checkNumber);

            if (exists) {
                bot.sendMessage(chatId, '⛔ Такой чек уже есть в базе!');
                delete userData[chatId];
                return;
            }

            const saved = await saveCheck(checkNumber);
            if (!saved) {
                bot.sendMessage(chatId, '❌ Ошибка сохранения чека.');
                delete userData[chatId];
                return;
            }

            userData[chatId].checkNumber = checkNumber;

            if (type === 'Простой') {
                userData[chatId].step++;
                bot.sendMessage(chatId, 'Введите время прибытия (ЧЧ:ММ):');
            } else {
                sendRequestToAdmin(chatId, msg.from);
                delete userData[chatId];
            }
        } else if (step === 3 && type === 'Простой') {
            userData[chatId].arrival = text;
            userData[chatId].step++;
            bot.sendMessage(chatId, 'Введите время убытия (ЧЧ:ММ):');
        } else if (step === 4 && type === 'Простой') {
            userData[chatId].departure = text;
            sendRequestToAdmin(chatId, msg.from);
            delete userData[chatId];
        }
    }
});

// === Отправка админам ===
function sendRequestToAdmin(userId, from) {
    const data = userData[userId];
    let messageText =
        `🚚 Новая заявка:\n` +
        `Тип: ${data.type}\n` +
        `Дата: ${data.date}\n` +
        `Чек: ${data.checkNumber}\n`;

    if (data.type === 'Простой') {
        messageText += `Прибытие: ${data.arrival}\nУбытие: ${data.departure}\n`;
    }

    messageText += `От пользователя: ${from.first_name} (${userId})`;

    ADMINS.forEach(adminId => {
        bot.sendMessage(adminId, messageText, {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Закрыто', callback_data: `approve_${userId}` },
                        { text: '❌ Отказано', callback_data: `reject_${userId}` }
                    ]
                ]
            }
        });
    });

    lockUserRequest(userId); // блокируем + таймер
    bot.sendMessage(userId, 'Заявка отправлена, ожидайте ответа.');
}

// === Обработка кнопок админа ===
bot.on('callback_query', (query) => {
    const [action, userId] = query.data.split('_');
    const fromId = query.from.id;

    if (!ADMINS.includes(fromId)) {
        bot.answerCallbackQuery(query.id, { text: '⛔ Только админ!', show_alert: true });
        return;
    }

    if (action === 'approve') {
        bot.sendMessage(userId, '✅ Заявка отработана.');
        delete activeRequests[userId];
        bot.answerCallbackQuery(query.id, { text: 'Готово.' });
    } else if (action === 'reject') {
        pendingRejections[fromId] = userId;
        bot.sendMessage(fromId, '✏ Введите причину отказа:');
        delete activeRequests[userId];
        bot.answerCallbackQuery(query.id, { text: 'Введите причину.' });
    }
});

app.get('/', (req, res) => res.send('Bot is running!'));
app.post(`/bot${TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`🌐 Server on ${PORT}`));
