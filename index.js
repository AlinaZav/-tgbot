const TelegramBot = require('node-telegram-bot-api');

// Получаем токен из переменной окружения
const token = process.env.TOKEN;

if (!token) {
    console.error("❌ Ошибка: токен не предоставлен! Установите переменную окружения TOKEN.");
    process.exit(1); // Останавливаем выполнение
}

const bot = new TelegramBot(token, { polling: true });

// ID админов
const ADMINS = [5202993972];

let acceptingRequests = true;
const userData = {};
const submittedChecks = new Set();
const pendingRejections = {};
const activeRequests = new Set(); // Храним пользователей с активной заявкой

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

// Открыть приём заявок
bot.onText(/\/open/, (msg) => {
    if (!ADMINS.includes(msg.from.id)) return;
    acceptingRequests = true;
    bot.sendMessage(msg.chat.id, '✅ Бот снова доступен!');
});

// Закрыть приём заявок
bot.onText(/\/close/, (msg) => {
    if (!ADMINS.includes(msg.from.id)) return;
    acceptingRequests = false;
    bot.sendMessage(msg.chat.id, '⛔ Бот временно не работает по техническим причинам.');
});

// Старт
bot.onText(/\/start/, (msg) => {
    sendMainMenu(msg.chat.id);
});

// Обработка сообщений
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Если админ пишет причину отказа
    if (pendingRejections[chatId]) {
        const targetUser = pendingRejections[chatId];
        bot.sendMessage(targetUser, `❌ Отказано: ${text}`);
        bot.sendMessage(chatId, 'Причина отказа отправлена водителю.');
        activeRequests.delete(targetUser); // Разблокируем пользователя
        delete pendingRejections[chatId];
        return;
    }

    // Блокируем создание новой заявки, если у пользователя уже есть активная
    if (activeRequests.has(chatId) && !userData[chatId] && ['Простой', 'Перепробег', 'Отказ от доставки'].includes(text) === false) {
        bot.sendMessage(chatId, '⛔ У вас уже есть активная заявка. Дождитесь обработки.');
        return;
    }

    // Автоматически показываем меню, если бот не в режиме диалога
    if (!userData[chatId] && !['Простой', 'Перепробег', 'Отказ от доставки'].includes(text)) {
        sendMainMenu(chatId);
        return;
    }

    if (!acceptingRequests && !ADMINS.includes(msg.from.id)) {
        bot.sendMessage(chatId, '⛔ Приём заявок сейчас закрыт.');
        return;
    }

    // Если пользователь выбрал тип заявки
    if (['Простой', 'Перепробег', 'Отказ от доставки'].includes(text)) {
        if (activeRequests.has(chatId)) {
            bot.sendMessage(chatId, '⛔ У вас уже есть активная заявка.');
            return;
        }
        userData[chatId] = { type: text, step: 1 };
        activeRequests.add(chatId); // Запоминаем, что у него активная заявка
        bot.sendMessage(chatId, 'Введите дату закрытия рейса (В формате ДД.ММ.ГГГГ):');
        return;
    }

    // Обработка шагов заполнения
    if (userData[chatId]) {
        const step = userData[chatId].step;
        const type = userData[chatId].type;

        if (step === 1) {
            userData[chatId].date = text;
            userData[chatId].step++;
            bot.sendMessage(chatId, 'Введите номер товарного чека (Полностью):');
        } else if (step === 2) {
            if (submittedChecks.has(text.toUpperCase())) {
                bot.sendMessage(chatId, '⛔ Такая заявка уже существует!');
                delete userData[chatId];
                activeRequests.delete(chatId);
                sendMainMenu(chatId);
                return;
            }
            userData[chatId].checkNumber = text.toUpperCase();
            submittedChecks.add(text.toUpperCase());

            if (type === 'Простой') {
                userData[chatId].step++;
                bot.sendMessage(chatId, 'Введите время прибытия на адрес (В формате ЧЧ:ММ):');
            } else {
                sendRequestToAdmin(chatId, msg.from);
                delete userData[chatId];
            }
        } else if (step === 3 && type === 'Простой') {
            userData[chatId].arrival = text;
            userData[chatId].step++;
            bot.sendMessage(chatId, 'Введите время убытия с адреса (В формате ЧЧ:ММ):');
        } else if (step === 4 && type === 'Простой') {
            userData[chatId].departure = text;
            sendRequestToAdmin(chatId, msg.from);
            delete userData[chatId];
        }
    }
});

// Отправка заявки админам
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

// Обработка нажатий админа
bot.on('callback_query', (query) => {
    const data = query.data;
    const fromId = query.from.id;

    if (!ADMINS.includes(fromId)) {
        bot.answerCallbackQuery(query.id, { text: '⛔ Только админ может это делать!', show_alert: true });
        return;
    }

    const [action, userId] = data.split('_');

    if (action === 'approve') {
        bot.sendMessage(userId, '✅ Заявка обработана. Ожидайте поступления.');
        activeRequests.delete(Number(userId)); // Разблокируем пользователя
        bot.answerCallbackQuery(query.id, { text: 'Заявка обработана.' });
    } else if (action === 'reject') {
        pendingRejections[fromId] = userId;
        bot.sendMessage(fromId, '✏ Введите причину отказа:');
        bot.answerCallbackQuery(query.id, { text: 'Напишите причину отказа.' });
    }
});
