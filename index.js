require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// === Переменные окружения ===
const TOKEN = process.env.TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Нет переменных окружения TOKEN, SUPABASE_URL или SUPABASE_KEY!');
  process.exit(1);
}

// === Инициализация Supabase ===
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// === Инициализация бота ===
const bot = new TelegramBot(TOKEN, { polling: true });

const ADMINS = [5234610042];
const userData = {};
const pendingRejections = {}; // { adminId: { userId, checkNumber, messageId } }

// ====== Utils ======
const normalizeCheck = (s = '') => s.toString().trim().toUpperCase();

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

async function saveCheck(checkNumber) {
  const { data, error } = await supabase
    .from('checks')
    .insert([{ check_number: checkNumber }])
    .select();

  if (error) {
    console.error('❌ Ошибка сохранения чека:', error);
    return { ok: false, duplicate: error.code === '23505' };
  }
  return { ok: true, data };
}

// ====== Меню ======
function showMenu(chatId) {
  bot.sendMessage(
    chatId,
    'Выберите тип заявки:',
    {
      reply_markup: {
        keyboard: [['Простой', 'Перепробег', 'Отказ от доставки']],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    }
  );
}

// ====== /start ======
bot.onText(/\/start/, (msg) => {
  delete userData[msg.chat.id];
  showMenu(msg.chat.id);
});

// ====== Основной обработчик сообщений ======
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // --- Если админ вводит причину отказа ---
  if (pendingRejections[chatId]) {
    const { userId, checkNumber, messageId } = pendingRejections[chatId];

    await bot.sendMessage(userId, `❌ Отказ по чеку №${checkNumber}. Причина: ${text}`);
    await bot.sendMessage(chatId, `❌ Отказ по чеку №${checkNumber}`, {
      reply_to_message_id: messageId
    });

    delete pendingRejections[chatId];
    showMenu(userId);
    return;
  }

  // --- Если юзер ещё не выбрал тип заявки ---
  if (!userData[chatId] && !['Простой', 'Перепробег', 'Отказ от доставки'].includes(text)) {
    bot.sendMessage(chatId, '⛔ Сначала выберите тип заявки.', {
      reply_markup: {
        keyboard: [['Простой', 'Перепробег', 'Отказ от доставки']],
        resize_keyboard: true
      }
    });
    return;
  }

  // --- Если выбрал тип заявки ---
  if (['Простой', 'Перепробег', 'Отказ от доставки'].includes(text)) {
    userData[chatId] = { type: text, step: 1 };
    bot.sendMessage(chatId, 'Введите дату рейса (ДД.ММ.ГГГГ):');
    return;
  }

  // --- Шаги заполнения заявки ---
  if (userData[chatId]) {
    const step = userData[chatId].step;
    const type = userData[chatId].type;

    if (step === 1) {
      userData[chatId].date = text;
      userData[chatId].step = 2;
      bot.sendMessage(chatId, 'Введите номер товарного чека (Полностью):');
      return;
    }

    if (step === 2) {
      const checkNumber = normalizeCheck(text);
      const exists = await checkExists(checkNumber);
      if (exists) {
        bot.sendMessage(chatId, '⛔ Такой чек уже есть в базе! Введите другой номер:');
        return;
      }

      const saved = await saveCheck(checkNumber);
      if (!saved.ok) {
        if (saved.duplicate) {
          bot.sendMessage(chatId, '⛔ Такой чек уже есть в базе! Введите другой номер:');
          return;
        }
        bot.sendMessage(chatId, '❌ Ошибка сохранения чека. Попробуйте позже.');
        delete userData[chatId];
        return;
      }

      userData[chatId].checkNumber = checkNumber;

      if (type === 'Простой') {
        userData[chatId].step = 3;
        bot.sendMessage(chatId, 'Введите время прибытия на адрес (ЧЧ:ММ):');
        return;
      }

      sendRequestToAdmin(chatId, msg.from);
      delete userData[chatId];
      return;
    }

    if (step === 3 && type === 'Простой') {
      userData[chatId].arrival = text;
      userData[chatId].step = 4;
      bot.sendMessage(chatId, 'Введите время убытия с адреса (ЧЧ:ММ):');
      return;
    }

    if (step === 4 && type === 'Простой') {
      userData[chatId].departure = text;
      sendRequestToAdmin(chatId, msg.from);
      delete userData[chatId];
      return;
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
    messageText += `Прибытие: ${data.arrival}\nУбытие: ${data.departure}\n`;
  }

  messageText += `От пользователя: ${from.first_name} (${userId})`;

  ADMINS.forEach((adminId) => {
    bot.sendMessage(adminId, messageText, {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Закрыто', callback_data: `approve_${userId}_${data.checkNumber}` },
          { text: '❌ Отказано', callback_data: `reject_${userId}_${data.checkNumber}` },
        ]],
      },
    });
  });

  bot.sendMessage(userId, `Заявка по чеку №${data.checkNumber} отправлена, ожидайте ответа.`);
}

// ====== Обработка нажатий на кнопки ======
bot.on('callback_query', async (query) => {
  const [action, userId, checkNumber] = query.data.split('_');
  const fromId = query.from.id;

  if (!ADMINS.includes(fromId)) {
    return bot.answerCallbackQuery(query.id, { text: '⛔ Только админ!', show_alert: true });
  }

  if (action === 'approve') {
    await bot.sendMessage(userId, `✅ Чек №${checkNumber} обработан. Ожидайте поступления.`);

    await bot.sendMessage(fromId, `✅ Заявка по чеку №${checkNumber} закрыта.`, {
      reply_to_message_id: query.message.message_id
    });

    bot.answerCallbackQuery(query.id, { text: 'Готово ✅' });
    showMenu(userId);

  } else if (action === 'reject') {
    pendingRejections[fromId] = { userId, checkNumber, messageId: query.message.message_id };

    await bot.sendMessage(fromId, '✏ Введите причину отказа:', {
      reply_to_message_id: query.message.message_id
    });

    bot.answerCallbackQuery(query.id, { text: 'Введите причину ❌' });
  }
});

console.log('🤖 Бот запущен (long polling)...');
