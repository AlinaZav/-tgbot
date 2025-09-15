require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Проверка переменных окружения
const TOKEN = process.env.TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Нет переменных окружения TOKEN, SUPABASE_URL или SUPABASE_KEY!');
  process.exit(1);
}


// Инициализация Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Инициализация бота
const bot = new TelegramBot(TOKEN, { polling: true });

const ADMINS = [5234610042];
let acceptingRequests = true;
const userData = {};
const pendingRejections = {};

// ====== Utils ======
const normalizeCheck = (s = '') => s.toString().trim().toUpperCase();

function validateCheckNumber(checkNumber) {
  // Минимальная длина 3 символа, максимальная 50
  if (!checkNumber || checkNumber.length < 3 || checkNumber.length > 50) {
    return false;
  }

  // Разрешаем буквы, цифры и некоторые специальные символы
  const regex = /^[a-zA-Z0-9\-_#]+$/;
  return regex.test(checkNumber);
}

// Функция проверки подключения к Supabase
async function testSupabaseConnection() {
  try {
    console.log('🔍 Проверка подключения к Supabase...');
    console.log('Supabase URL:', SUPABASE_URL);
    console.log('Supabase Key length:', SUPABASE_KEY ? SUPABASE_KEY.length : 'NULL');

    const { data, error } = await supabase
      .from('checks')
      .select('count')
      .limit(1);

    if (error) {
      console.error('❌ Ошибка подключения к Supabase:');
      console.error('Полная ошибка:', JSON.stringify(error, null, 2));
      console.error('Код ошибки:', error.code);
      console.error('Сообщение:', error.message);
      console.error('Детали:', error.details);
      return false;
    }

    console.log('✅ Подключение к Supabase успешно');
    return true;
  } catch (error) {
    console.error('❌ Неожиданная ошибка при подключении:');
    console.error('Stack:', error.stack);
    return false;
  }
}

// Проверка существования чека
async function checkExists(checkNumber) {
  try {
    console.log(`🔍 Проверка существования чека: ${checkNumber}`);

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const { data, error } = await supabase
      .from('checks')
      .select('id, check_number, created_at')
      .eq('check_number', checkNumber)
      .gte('created_at', threeMonthsAgo.toISOString());

    if (error) {
      console.error('Ошибка проверки чека:', JSON.stringify(error, null, 2));
      return false;
    }

    const exists = data && data.length > 0;
    console.log(`Чек ${checkNumber} ${exists ? 'существует' : 'не существует'}`);
    return exists;
  } catch (error) {
    console.error('Ошибка при проверке чека:', error);
    return false;
  }
}

// Сохранение чека
async function saveCheck(checkNumber) {
  try {
    console.log(`💾 Попытка сохранения чека: ${checkNumber}`);
    console.log('Supabase URL:', SUPABASE_URL);
    console.log('Supabase Key length:', SUPABASE_KEY ? SUPABASE_KEY.length : 'NULL');

    const checkData = {
      check_number: checkNumber,
      created_at: new Date().toISOString()
    };

    console.log('Данные для сохранения:', checkData);

    const { data, error } = await supabase
      .from('checks')
      .insert([checkData])
      .select('id, check_number, created_at');

    if (error) {
      console.error('❌ Ошибка сохранения чека:');
      console.error('Полная ошибка:', JSON.stringify(error, null, 2));
      console.error('Код ошибки:', error.code);
      console.error('Сообщение:', error.message);
      console.error('Детали:', error.details);
      console.error('Хинт:', error.hint);

      return {
        ok: false,
        duplicate: error.code === '23505',
        error: error.message
      };
    }

    console.log('✅ Чек успешно сохранён:', data);
    return { ok: true, data: data[0] };
  } catch (error) {
    console.error('❌ Неожиданная ошибка при сохранении:');
    console.error('Stack:', error.stack);
    console.error('Full error:', error);
    return { ok: false, error: error.message };
  }
}

// Проверка подключения перед запросом
async function ensureConnection() {
  try {
    const { error } = await supabase.from('checks').select('count').limit(1);
    return !error;
  } catch {
    return false;
  }
}

// ====== Show menu ======
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

// ====== Handlers ======
bot.onText(/\/start/, (msg) => {
  delete userData[msg.chat.id];
  showMenu(msg.chat.id);
});

// Команда для тестирования базы данных
bot.onText(/\/test_db/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    bot.sendMessage(chatId, '🧪 Тестируем подключение к базе данных...');

    const connectionTest = await testSupabaseConnection();
    if (!connectionTest) {
      bot.sendMessage(chatId, '❌ Ошибка подключения к Supabase');
      return;
    }

    const testCheck = 'TEST_' + Date.now();
    const saveResult = await saveCheck(testCheck);

    if (saveResult.ok) {
      bot.sendMessage(chatId, `✅ Тест пройден успешно!\nСохранён чек: ${testCheck}`);
    } else {
      bot.sendMessage(chatId, `❌ Ошибка сохранения: ${saveResult.error}`);
    }
  } catch (error) {
    bot.sendMessage(chatId, `❌ Критическая ошибка: ${error.message}`);
  }
});

// Команда для отладки чека
bot.onText(/\/debug_check (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const checkNumber = match[1];

  bot.sendMessage(chatId, `🔍 Тестируем чек: ${checkNumber}`);

  // Проверка существования
  const exists = await checkExists(checkNumber);
  bot.sendMessage(chatId, `Проверка существования: ${exists ? 'существует' : 'не существует'}`);

  // Попытка сохранения
  const result = await saveCheck(checkNumber);
  bot.sendMessage(chatId, `Результат сохранения: ${JSON.stringify(result, null, 2)}`);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // Если админ вводит причину отказа
  if (pendingRejections[chatId]) {
    const { userId, checkNumber } = pendingRejections[chatId];
    bot.sendMessage(userId, `❌ Отказ по чеку №${checkNumber}. Причина: ${text}`);
    bot.sendMessage(chatId, 'Причина отказа отправлена.');
    delete pendingRejections[chatId];
    showMenu(userId);
    return;
  }

  // Запрет писать до выбора типа заявки
  if (!userData[chatId] && !['Простой', 'Перепробег', 'Отказ от доставки'].includes(text)) {
    bot.sendMessage(chatId, '⛔ Сначала выберите тип заявки.', {
      reply_markup: {
        keyboard: [['Простой', 'Перепробег', 'Отказ от доставки']],
        resize_keyboard: true
      }
    });
    return;
  }

  // Если выбрал тип заявки
  if (['Простой', 'Перепробег', 'Отказ от доставки'].includes(text)) {
    userData[chatId] = { type: text, step: 1 };
    bot.sendMessage(chatId, 'Введите дату рейса (ДД.ММ.ГГГГ):');
    return;
  }

  // Обработка шагов
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
      console.log(`📋 Обработка чека: ${checkNumber} для пользователя: ${chatId}`);

      // Валидация номера чека
      if (!validateCheckNumber(checkNumber)) {
        bot.sendMessage(chatId, '⛔ Неверный формат номера чека. Используйте только буквы, цифры и символы -_#. Длина от 3 до 50 символов.');
        return;
      }

      // Проверка подключения
      const isConnected = await ensureConnection();
      if (!isConnected) {
        bot.sendMessage(chatId, '❌ Нет подключения к базе данных. Попробуйте позже.');
        return;
      }

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
        console.error('Ошибка сохранения:', saved.error);
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

function sendRequestToAdmin(userId, from) {
  const data = userData[userId];
  let messageText =
    `🚚 Новая заявка:\n` +
    `Тип: ${data.type}\n` +
    `Дата: ${data.date}\n` +
    `Товарный чек: ${data.checkNumber}\n`;

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

bot.on('callback_query', (query) => {
  const [action, userId, checkNumber] = query.data.split('_');
  const fromId = query.from.id;

  if (!ADMINS.includes(fromId)) {
    bot.answerCallbackQuery(query.id, { text: '⛔ Только админ!', show_alert: true });
    return;
  }

  if (action === 'approve') {
    bot.sendMessage(userId, `✅ Чек №${checkNumber} обработан. Ожидайте поступления.`);
    bot.sendMessage(fromId, '✅ Заявка отработана.');
    bot.answerCallbackQuery(query.id, { text: 'Готово.' });
    showMenu(userId);
  } else if (action === 'reject') {
    pendingRejections[fromId] = { userId, checkNumber };
    bot.sendMessage(fromId, '✏ Введите причину отказа:');
    bot.answerCallbackQuery(query.id, { text: 'Введите причину.' });
  }
});

// Проверка подключения при старте
testSupabaseConnection().then(success => {
  if (!success) {
    console.error('❌ Критическая ошибка: не удалось подключиться к Supabase');
    process.exit(1);
  }
  console.log('🤖 Бот запущен (long polling)...');
});

// Обработка ошибок бота
bot.on('error', (error) => {
  console.error('❌ Ошибка Telegram Bot API:');
  console.error(error);
});

bot.on('polling_error', (error) => {
  console.error('❌ Ошибка polling:');
  console.error(error);
});