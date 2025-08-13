// ====== Запуск мини-веб-сервера ======
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 8000;
const TOKEN = process.env.TOKEN;

if (!TOKEN) {
    console.error("❌ Переменная окружения TOKEN не задана!");
    process.exit(1);
}

// ====== Создаём бота в режиме webhook ======
const bot = new TelegramBot(TOKEN);
const WEBHOOK_URL = `https://serious-leola-botpetr-c7d2426b.koyeb.app/bot${TOKEN}`;

bot.setWebHook(WEBHOOK_URL)
    .then(() => console.log(`✅ Webhook установлен: ${WEBHOOK_URL}`))
    .catch(err => console.error("❌ Ошибка установки webhook:", err));

// ====== Хранилища данных ======
const ADMINS = [5202993972];
let acceptingRequests = true;
const userData = {};
const submittedChecks = new Set();
const pendingRejections = {};
const activeRequests = {};

// ====== Обработка входящих апдейтов ======
app.post(`/bot${TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// ====== Главное меню ======
function sendMainMenu(chatId) {
    bot.sendMessage(chatId, 'Выберите тип заявки:', {
        reply_markup: {
            keyboard: [
                ['Простой'],
                ['Перепробег'],
                ['Отказ от доставки']
            ],
            resize_keyboard: true
        }
    });
}

// ====== Команды ======
bot.onText(/\/open/, (msg) => {
    if (!ADMINS.includes(msg.from.id)) return;
    acceptingRequests = true;
    bot.sendMessage(msg.chat.id, '✅ Бот снова доступен!');
});

bot.onText(/\/close/, (msg) => {
    if (!ADMINS.includes(msg.from.id)) return;
    acceptingRequests = false;
    bot.sendMessage(msg.chat.id, '⛔ Приём заявок закрыт.');
});

bot.onText(/\/start/, (msg) => {
    sendMainMenu(msg.chat.id);
});

// ====== Логика обработки сообщений ======
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Админ пишет причину отказа
    if (pendingRejections[chatId]) {
        const targetUser = pendingRejections[chatId];
        bot.sendMessage(targetUser, `❌ Отказано: ${text}`);
        sendMainMenu(targetUser); // показываем меню после отказа

        bot.sendMessage(chatId, 'Причина отказа отправлена.');
        delete pendingRejections[chatId];
        delete activeRequests[targetUser];
        return;
    }

    // Уже есть активная заявка
    if (activeRequests[chatId]) {
        bot.sendMessage(chatId, '⛔ Вы уже отправили заявку. Дождитесь её обработки.');
        return;
    }

    // Приём заявок закрыт
    if (!acceptingRequests && !ADMINS.includes(msg.from.id)) {
        bot.sendMessage(chatId, '⛔ Приём заявок сейчас закрыт.');
        return;
    }

    // Выбор типа
    if (['Простой', 'Перепробег', 'Отказ от доставки'].includes(text)) {
        userData[chatId] = { type: text, step: 1 };
        bot.sendMessage(chatId, 'Введите дату закрытия рейса (ДД.ММ.ГГГГ):');
        return;
    }

    // Заполнение заявки
    if (userData[chatId]) {
        const step = userData[chatId].step;
        const type = userData[chatId].type;

        if (step === 1) {
            userData[chatId].date = text;
            userData[chatId].step++;
            bot.sendMessage(chatId, 'Введите номер товарного чека:');
        } else if (step === 2) {
            if (submittedChecks.has(text.toUpperCase())) {
                bot.sendMessage(chatId, '⛔ Такая заявка уже существует!');
                delete userData[chatId];
                sendMainMenu(chatId);
                return;
            }
            userData[chatId].checkNumber = text.toUpperCase();
            submittedChecks.add(text.toUpperCase());

            if (type === 'Простой') {
                userData[chatId].step++;
                bot.sendMessage(chatId, 'Введите время прибытия (ЧЧ:ММ):');
            } else {
                activeRequests[chatId] = true;
                sendRequestToAdmin(chatId, msg.from);
                delete userData[chatId];
            }
        } else if (step === 3 && type === 'Простой') {
            userData[chatId].arrival = text;
            userData[chatId].step++;
            bot.sendMessage(chatId, 'Введите время убытия (ЧЧ:ММ):');
        } else if (step === 4 && type === 'Простой') {
            userData[chatId].departure = text;
            activeRequests[chatId] = true;
            sendRequestToAdmin(chatId, msg.from);
            delete userData[chatId];
        }
    }
});

// ====== Отправка заявки админу ======
function sendRequestToAdmin(userId, from) {
    const data = userData[userId];
    let messageText =
        `🚚 Новая заявка:\n` +
        `Тип: ${data.type}\n` +
        `Дата: ${data.date}\n` +
        `Чек: ${data.checkNumber}\n`;

    if (data.type === 'Простой') {
        messageText += `Прибытие: ${data.arrival}\n` +
                       `Убытие: ${data.departure}\n`;
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

    bot.sendMessage(userId, 'Заявка отправлена, ожидайте ответа.');
}

// ====== Обработка кнопок ======
bot.on('callback_query', (query) => {
    const [action, userId] = query.data.split('_');
    const fromId = query.from.id;

    if (!ADMINS.includes(fromId)) {
        bot.answerCallbackQuery(query.id, { text: '⛔ Только админ может это делать!', show_alert: true });
        return;
    }

    if (action === 'approve') {
        bot.sendMessage(userId, '✅ Заявка отработана. Ожидайте поступления.');
        sendMainMenu(userId); // после одобрения сразу меню
        bot.sendMessage(fromId, 'Заявка обработана.');
        delete activeRequests[userId];
        bot.answerCallbackQuery(query.id, { text: 'Заявка обработана.' });
    } else if (action === 'reject') {
        pendingRejections[fromId] = userId;
        bot.sendMessage(fromId, '✏ Введите причину отказа:');
        bot.answerCallbackQuery(query.id, { text: 'Напишите причину отказа.' });
    }
});

// ====== Запуск сервера ======
app.get('/', (req, res) => {
    res.send('Bot is running!');
});

app.listen(PORT, () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});
