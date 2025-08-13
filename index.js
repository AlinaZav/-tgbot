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
  console.error('❌ Нет переменных окружения TOKEN, SUPABASE_URL или SUPABASE_KEY!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ====== Telegram bot (webhook) ======
const bot = new TelegramBot(TOKEN);
const WEBHOOK_URL = `https://serious-leola-botpetr-c7d2426b.koyeb.app/bot${TOKEN}`;
bot.setWebHook(WEBHOOK_URL);

// ====== State ======
const ADMINS = [5202993972];
let acceptingRequests = true;
const userData = {};
const pendingRejections = {};
const activeRequests = {};

// Нормализация чека
const normalizeCheck = (s = '') => s.toString().trim().toUpperCase();

// --- Проверка в БД за 3 месяца (быстрая)
async function checkExists(checkNumber) {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const { data, error } = await supabase
    .from('checks')
    .select('id')
    .eq('check_number', checkNumber)
    .gte('created_at', threeMonthsAgo.toISOString());

  if (error) {
    console.error('Ошибка проверки чека:', error);
    return false;
  }
  return data && data.length > 0;
}

// --- Сохранение, с ловлей уникального ограничения
async function saveCheck(checkNumber) {
  const { error } = await supabase
    .from('checks')
    .insert([{ check_number: checkNumber, created_at: new Date().toISOString() }]);

  if (error) {
    // 23505 — unique_violation в Postgres
    if (error.code === '23505') {
      return { ok: false, duplicate: true };
    }
    console.error('Ошибка сохранения чека:', error);
    return { ok: false, duplicate: false };
  }
  return { ok: true };
}

// ====== Handlers ======
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // Админ вводит причину отказа
  if (pendingRejections[chatId]) {
    const targetUser = pendingRejections[chatId];
    bot.sendMessage(targetUser, `❌ Отказано: ${text}`);
    bot.sendMessage(chatId, 'Причина отказа отправлена.');
    delete pendingRejections[chatId];
    return;
  }

  // У пользователя уже есть необработанная заявка
  if (activeRequests[chatId]) {
    bot.sendMessage(chatId, '⛔ Вы уже отправили заявку.');
    return;
  }

  // Приём заявок закрыт
  if (!acceptingRequests && !ADMINS.includes(msg.from.id)) {
    bot.sendMessage(chatId, '⛔ Приём заявок закрыт.');
    return;
  }

  // Старт сценария
  if (['Простой', 'Перепробег', 'Отказ от доставки'].includes(text)) {
    userData[chatId] = { type: text, step: 1 };
    bot.sendMessage(chatId, 'Введите дату закрытия рейса (ДД.ММ.ГГГГ):');
    return;
  }

  // Продолжение сценария
  if (userData[chatId]) {
    const step = userData[chatId].step;
    const type = userData[chatId].type;

    if (step === 1) {
      userData[chatId].date = text;
      userData[chatId].step = 2;
      bot.sendMessage(chatId, 'Введите номер товарного чека:');
      return;
    }

    if (step === 2) {
      const checkNumber = normalizeCheck(text);

      // 1) Быстрая проверка (за 3 мес.)
      const exists = await checkExists(checkNumber);
      if (exists) {
        bot.sendMessage(chatId, '⛔ Такой чек уже есть в базе! Введите другой номер:');
        return; // остаёмся на шаге 2
      }

      // 2) Сохранение с ловлей "unique_violation" (страховка от гонок/старых записей)
      const saved = await saveCheck(checkNumber);
      if (!saved.ok) {
        if (saved.duplicate) {
          bot.sendMessage(chatId, '⛔ Такой чек уже есть в базе! Введите другой номер:');
          return; // остаёмся на шаге 2
        }
        bot.sendMessage(chatId, '❌ Ошибка сохранения чека. Попробуйте позже.');
        delete userData[chatId];
        return;
      }

      userData[chatId].checkNumber = checkNumber;

      if (type === 'Простой') {
        userData[chatId].step = 3;
        bot.sendMessage(chatId, 'Введите время прибытия (ЧЧ:ММ):');
        return;
      }

      // Для остальных типов сразу отправляем админу
      activeRequests[chatId] = true;
      sendRequestToAdmin(chatId, msg.from);
      delete userData[chatId];
      return;
    }

    if (step === 3 && type === 'Простой') {
      userData[chatId].arrival = text;
      userData[chatId].step = 4;
      bot.sendMessage(chatId, 'Введите время убытия (ЧЧ:ММ):');
      return;
    }

    if (step === 4 && type === 'Простой') {
      userData[chatId].departure = text;
      activeRequests[chatId] = true;
      sendRequestToAdmin(chatId, msg.from);
      delete userData[chatId];
      return;
    }
  }
});

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

  ADMINS.forEach((adminId) => {
    bot.sendMessage(adminId, messageText, {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Закрыто', callback_data: `approve_${userId}` },
          { text: '❌ Отказано', callback_data: `reject_${userId}` },
        ]],
      },
    });
  });

  bot.sendMessage(userId, 'Заявка отправлена, ожидайте ответа.');
}

bot.on('callback_query', (query) => {
  const [action, userId] = query.data.split('_');
  const fromId = query.from.id;

  if (!ADMINS.includes(fromId)) {
    bot.answerCallbackQuery(query.id, { text: '⛔ Только админ!', show_alert: true });
    return;
  }

  if (action === 'approve') {
    bot.sendMessage(userId, '✅ Заявка отработана.');
     bot.sendMessage(fromId, '✅ Заявка отработана.');
    delete activeRequests[userId];
    bot.answerCallbackQuery(query.id, { text: 'Готово.' });
  } else if (action === 'reject') {
    pendingRejections[fromId] = userId;
    bot.sendMessage(fromId, '✏ Введите причину отказа:');
    bot.answerCallbackQuery(query.id, { text: 'Введите причину.' });
  }
});

// ====== Web server ======
app.get('/', (req, res) => res.send('Bot is running!'));
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`🌐 Server on ${PORT}`));
