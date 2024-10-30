require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const qr = require('qr-image');
const fs = require('fs');
const path = require('path');
const winston = require('winston');

// Налаштування логера
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' }),
  ],
});

const token = process.env.TELEGRAM_BOT_TOKEN;
// const monoMerchantToken = process.env.MONOBANK_MERCHANT_TOKEN; // Закоментовано для "Прямого платежу"

const bot = new TelegramBot(token, { polling: true });

const events = [
  { id: 1, name: 'Концерт А', price: 500 }, // Ціна в копійках (UAH)
  { id: 2, name: 'Фестиваль Б', price: 750 },
];

// Шляхи до файлів
const ordersFilePath = path.join(__dirname, 'orders.json');
const userStatesFilePath = path.join(__dirname, 'userStates.json');
const jarsFilePath = path.join(__dirname, 'jars.json');

// Функція для завантаження даних з файлу
const loadData = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    } else {
      return {};
    }
  } catch (error) {
    logger.error(`Помилка при завантаженні даних з файлу ${filePath}: ${error}`);
    return {};
  }
};

// Функція для збереження даних у файл
const saveData = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    logger.error(`Помилка при збереженні даних у файл ${filePath}: ${error}`);
  }
};

// Завантажуємо дані при старті сервера
let orders = loadData(ordersFilePath);
let userStates = loadData(userStatesFilePath);

// Масив банок з їх параметрами та станом
let jars = loadData(jarsFilePath);
if (Object.keys(jars).length === 0) {
  // Ініціалізуємо банки, якщо файл порожній
  jars = {
    1: {
      id: 1,
      Pc: 'BJR6mYIOGCZLbsfKoLtngOGVPTYJMPoxYAxipw4LfywhDJjJZGSuxfc6g6q/8dxzbEHM8ygdEMEyev30jYE/GA4=',
      c: 'hello',
      clientId: 'AB3wzETu3o',
      referer: '',
      url: 'https://send.monobank.ua/jar/AB3wzETu3o',
      isReserved: false,
      reservedBy: null,
      reservedAt: null,
    },
    2: {
      id: 2,
      Pc: 'BAvCNDz9W4AILfiH85PcwtlgXqJAvtpnTRFX56Qu3kbl0WVgH+vYsIoSxOYP1avBd1CyiYibY/X9hCwZj35B0Mo=',
      c: 'hello',
      clientId: 'SzjFuD6UW',
      referer: '',
      url: 'https://send.monobank.ua/jar/SzjFuD6UW',
      isReserved: false,
      reservedBy: null,
      reservedAt: null,
    },
  };
  saveData(jarsFilePath, jars);
}

// Змінна для зберігання попереднього балансу банок
let previousJarAmounts = {};

// Обробка команди /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  handleMainMenu(chatId);
});

// Обробка повідомлень від користувача
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!userStates[chatId]) {
    userStates[chatId] = { state: 'main_menu' };
    saveData(userStatesFilePath, userStates);
  }

  const userState = userStates[chatId];

  switch (userState.state) {
    case 'main_menu':
      if (text === '🎫 Доступні івенти') {
        handleSelectingEvent(chatId);
      } else if (text === 'ℹ️ Допомога') {
        handleHelp(chatId);
      } else {
        bot.sendMessage(chatId, 'Будь ласка, оберіть опцію з меню.');
      }
      break;

    case 'selecting_event':
      handleSelectingQuantity(chatId, text);
      break;

    case 'selecting_quantity':
      handleSelectingPaymentMethod(chatId, text);
      break;

    case 'selecting_payment_method':
      handlePaymentMethod(chatId, text);
      break;

    case 'waiting_for_payment_confirmation':
      handlePaymentConfirmation(chatId, text);
      break;

    default:
      handleMainMenu(chatId);
      break;
  }
});


// Функції для обробки різних станів користувача

// Головне меню
const handleMainMenu = (chatId) => {
  const mainMenu = {
    reply_markup: {
      keyboard: [[{ text: '🎫 Доступні івенти' }], [{ text: 'ℹ️ Допомога' }]],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };

  bot.sendMessage(chatId, 'Вітаємо! Оберіть опцію з меню:', mainMenu);

  userStates[chatId] = { state: 'main_menu' };
  saveData(userStatesFilePath, userStates);
};

// Вибір івенту
const handleSelectingEvent = (chatId) => {
  const eventButtons = events.map((event) => {
    return [{ text: `${event.name} - ${event.price / 100} грн.` }];
  });

  const options = {
    reply_markup: {
      keyboard: eventButtons,
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  };

  bot.sendMessage(chatId, 'Оберіть івент:', options);

  userStates[chatId].state = 'selecting_event';
  saveData(userStatesFilePath, userStates);
};

// Вибір кількості квитків
const handleSelectingQuantity = (chatId, text) => {
  const selectedEvent = events.find((event) => event.name === getTitle(text));
  if (selectedEvent) {
    userStates[chatId].selectedEvent = selectedEvent;

    const quantityButtons = [];
    for (let i = 1; i <= 5; i++) {
      quantityButtons.push([{ text: `${i}` }]);
    }

    const options = {
      reply_markup: {
        keyboard: quantityButtons,
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    };

    bot.sendMessage(chatId, `Виберіть кількість квитків на *${selectedEvent.name}*:`, {
      parse_mode: 'Markdown',
      ...options,
    });

    userStates[chatId].state = 'selecting_quantity';
    saveData(userStatesFilePath, userStates);
  } else {
    bot.sendMessage(chatId, '❗️ Обраний івент не знайдено. Будь ласка, оберіть зі списку.');
  }
};

// Вибір способу оплати
const handleSelectingPaymentMethod = (chatId, text) => {
  const quantity = parseInt(text);
  if (!isNaN(quantity) && quantity >= 1 && quantity <= 5) {
    userStates[chatId].quantity = quantity;

    const paymentMethodButtons = [
      // [{ text: '💳 Прямий платіж' }], // Закоментовано
      [{ text: '💰 Оплата на банку' }],
    ];

    const options = {
      reply_markup: {
        keyboard: paymentMethodButtons,
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    };

    bot.sendMessage(chatId, 'Оберіть спосіб оплати:', options);

    userStates[chatId].state = 'selecting_payment_method';
    saveData(userStatesFilePath, userStates);
  } else {
    bot.sendMessage(chatId, '❗️ Будь ласка, оберіть кількість квитків від 1 до 5.');
  }
};

// Обробка вибору способу оплати
const handlePaymentMethod = (chatId, text) => {
  const paymentMethod = text;

  // if (paymentMethod === '💳 Прямий платіж') {
  //   // Закоментовано опцію "Прямий платіж"
  //   bot.sendMessage(chatId, 'Опція "💳 Прямий платіж" наразі недоступна.');
  //   handleMainMenu(chatId);
  // }

  if (paymentMethod === '💰 Оплата на банку') {
    const userState = userStates[chatId];
    const selectedEvent = userState.selectedEvent;
    const quantity = userState.quantity;
    const totalPrice = selectedEvent.price * quantity;
    const totalPriceGrn = totalPrice / 100;

    const reference = `jar_${selectedEvent.id}_${chatId}_${Date.now()}`;

    // Очищаємо старі бронювання перед призначенням банки
    clearOldReservations();

    // Призначаємо банку користувачу
    const assignedJar = assignJarToUser(chatId);
    if (!assignedJar) {
      bot.sendMessage(chatId, '❗️ Наразі всі банки зайняті. Спробуйте пізніше.');
      handleMainMenu(chatId);
      return;
    }

    userState.orderInfo = {
      chatId: chatId,
      eventId: selectedEvent.id,
      quantity: quantity,
      totalPrice: totalPriceGrn,
      reference: reference,
      paymentConfirmed: false,
      jar: assignedJar, // Зберігаємо параметри банки
      createdAt: Date.now(),
    };

    orders[reference] = userState.orderInfo;
    saveData(ordersFilePath, orders);

    // Отримуємо поточний баланс банки користувача
    getJarAmount(assignedJar)
      .then((amount) => {
        previousJarAmounts[chatId] = amount;

        bot.sendMessage(
          chatId,
          `Для оплати ${quantity} квитків на *${selectedEvent.name}* на суму ${totalPriceGrn} грн перейдіть за посиланням:\n${assignedJar.url}`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              remove_keyboard: true,
            },
          }
        );

        bot.sendMessage(chatId, 'Після здійснення оплати, натисніть "✅ Я оплатив", щоб отримати квитки.', {
          reply_markup: {
            keyboard: [[{ text: '✅ Я оплатив' }, { text: '❌ Скасувати' }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        });

        userState.state = 'waiting_for_payment_confirmation';
        saveData(userStatesFilePath, userStates);
      })
      .catch((error) => {
        logger.error(`Помилка при отриманні балансу банки: ${error}`);
        bot.sendMessage(chatId, '❗️ Сталася помилка. Спробуйте пізніше.');
        handleMainMenu(chatId);
      });
  } else {
    bot.sendMessage(chatId, '❗️ Будь ласка, оберіть спосіб оплати зі списку.');
  }
};

// Підтвердження оплати або скасування
const handlePaymentConfirmation = (chatId, text) => {
  const userState = userStates[chatId];
  const orderInfo = userState.orderInfo;

  if (text === '✅ Я оплатив') {
    checkJarPayment(orderInfo.totalPrice, orderInfo.jar, chatId)
      .then((paymentConfirmed) => {
        if (paymentConfirmed) {
          sendTickets(chatId, orderInfo);
          releaseJar(orderInfo.jar.id);

          userStates[chatId] = { state: 'main_menu' };
          saveData(userStatesFilePath, userStates);
          delete orders[orderInfo.reference];
          saveData(ordersFilePath, orders);
        } else {
          bot.sendMessage(chatId, '❗️ Оплату не підтверджено. Будь ласка, переконайтеся, що ви здійснили оплату, та спробуйте знову.', {
            reply_markup: {
              keyboard: [[{ text: '✅ Я оплатив' }, { text: '❌ Скасувати' }]],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          });
        }
      })
      .catch((error) => {
        logger.error(`Помилка при перевірці оплати: ${error}`);
        bot.sendMessage(chatId, '❗️ Сталася помилка при перевірці оплати. Спробуйте пізніше.');
      });
  } else if (text === '❌ Скасувати') {
    // Звільняємо банку
    releaseJar(orderInfo.jar.id);

    // Видаляємо замовлення
    delete orders[orderInfo.reference];
    saveData(ordersFilePath, orders);

    bot.sendMessage(chatId, '❌ Ваше замовлення було скасовано.', {
      reply_markup: {
        keyboard: [[{ text: '🎫 Доступні івенти' }], [{ text: 'ℹ️ Допомога' }]],
        resize_keyboard: true,
        one_time_keyboard: false,
      },
    });

    userStates[chatId] = { state: 'main_menu' };
    saveData(userStatesFilePath, userStates);
  } else {
    bot.sendMessage(chatId, '❗️ Будь ласка, оберіть опцію з меню.', {
      reply_markup: {
        keyboard: [[{ text: '✅ Я оплатив' }, { text: '❌ Скасувати' }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }
};

// Відправка квитків користувачу
const sendTickets = (chatId, orderInfo) => {
  const selectedEvent = events.find((event) => event.id === orderInfo.eventId);
  const quantity = orderInfo.quantity;
  const reference = orderInfo.reference;

  for (let i = 1; i <= quantity; i++) {
    const ticketCode = `${reference}_${i}`;
    const ticketInfo = `Квиток №${i} на ${selectedEvent.name}\nУнікальний код: ${ticketCode}`;

    const qr_png = qr.image(ticketInfo, { type: 'png' });
    const qrPath = path.join(__dirname, `${ticketCode}.png`);
    const writeStream = fs.createWriteStream(qrPath);

    qr_png.pipe(writeStream);

    writeStream.on('finish', () => {
      bot
        .sendPhoto(chatId, qrPath, {
          caption: `✅ Ваш квиток №${i} на *${selectedEvent.name}*.`,
          parse_mode: 'Markdown',
        })
        .then(() => {
          fs.unlinkSync(qrPath);
        })
        .catch((err) => {
          logger.error(`Помилка при відправці квитка: ${err}`);
        });
    });
  }

  bot.sendMessage(chatId, '✅ Дякуємо за покупку! Всі ваші квитки були надіслані.', {
    reply_markup: {
      keyboard: [[{ text: '🎫 Доступні івенти' }], [{ text: 'ℹ️ Допомога' }]],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
};

// Функція допомоги
const handleHelp = (chatId) => {
  bot.sendMessage(
    chatId,
    'Це бот для придбання квитків на музичні івенти. Оберіть "🎫 Доступні івенти", щоб переглянути список.'
  );
};

// Інші допоміжні функції

const getTitle = (text) => {
  const match = text.match(/^[^-]+/);
  return match ? match[0].trim() : '';
};

// Функція для призначення банки користувачу
const assignJarToUser = (chatId) => {
  // Очищаємо старі бронювання
  clearOldReservations();

  // Знаходимо вільну банку
  let freeJar = null;
  for (const jarId in jars) {
    const jar = jars[jarId];
    if (!jar.isReserved) {
      freeJar = jar;
      break;
    }
  }

  // Якщо немає вільних банок, знаходимо банку з найстарішим резервуванням
  if (!freeJar) {
    let oldestJar = null;
    let oldestTime = Date.now();
    for (const jarId in jars) {
      const jar = jars[jarId];
      if (jar.reservedAt && jar.reservedAt < oldestTime) {
        oldestTime = jar.reservedAt;
        oldestJar = jar;
      }
    }
    if (oldestJar) {
      // Перезаписуємо резервування
      freeJar = oldestJar;
      logger.info(`Банка ${freeJar.id} була перезарезервована для чату ${chatId}`);
    } else {
      // Немає доступних банок
      return null;
    }
  }

  // Резервуємо банку за користувачем
  freeJar.isReserved = true;
  freeJar.reservedBy = chatId;
  freeJar.reservedAt = Date.now();
  saveData(jarsFilePath, jars);

  return freeJar;
};

// Функція для звільнення банки
const releaseJar = (jarId) => {
  if (jars[jarId]) {
    jars[jarId].isReserved = false;
    jars[jarId].reservedBy = null;
    jars[jarId].reservedAt = null;
    saveData(jarsFilePath, jars);
    logger.info(`Банка ${jarId} була звільнена`);
  }
};

// Функція для очищення старих бронювань
const clearOldReservations = () => {
  const now = Date.now();
  const reservationTimeout = 12 * 60 * 60 * 1000; // 12 годин в мілісекундах

  for (const jarId in jars) {
    const jar = jars[jarId];
    if (jar.isReserved && jar.reservedAt && now - jar.reservedAt > reservationTimeout) {
      logger.info(`Банка ${jarId} була звільнена через закінчення часу резервування`);
      releaseJar(jarId);
    }
  }

  // Також очищаємо старі замовлення
  for (const reference in orders) {
    const order = orders[reference];
    if (order.createdAt && now - order.createdAt > reservationTimeout) {
      logger.info(`Замовлення ${reference} було видалено через закінчення часу очікування`);
      // Звільняємо банку, якщо потрібно
      if (order.jar && order.jar.id) {
        releaseJar(order.jar.id);
      }
      delete orders[reference];
      saveData(ordersFilePath, orders);
    }
  }
};

// Функція для отримання балансу банки
const getJarAmount = async (jar) => {
  try {
    const response = await axios.post(
      'https://send.monobank.ua/api/handler',
      {
        Pc: jar.Pc,
        c: jar.c,
        clientId: jar.clientId,
        referer: jar.referer,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    const data = response.data;

    if (data && data.jarAmount !== undefined) {
      return parseFloat(data.jarAmount);
    } else {
      // Якщо jarAmount не повертається, вважаємо його рівним 0
      return 0;
    }
  } catch (error) {
    logger.error(`Помилка при отриманні балансу банки: ${error}`);
    // У випадку помилки, вважаємо баланс рівним 0
    return 0;
  }
};

// Функція для перевірки оплати
const checkJarPayment = async (expectedAmount, jar, chatId) => {
  try {
    const currentAmount = await getJarAmount(jar);
    const previousAmount = previousJarAmounts[chatId] || 0;
    const amountDifference = currentAmount - previousAmount;

    logger.info(
      `Попередній баланс для чату ${chatId}: ${previousAmount}, поточний баланс: ${currentAmount}, різниця: ${amountDifference}`
    );

    if (amountDifference >= expectedAmount) {
      previousJarAmounts[chatId] = currentAmount;
      return true;
    } else {
      return false;
    }
  } catch (error) {
    logger.error(`Помилка при перевірці оплати: ${error}`);
    throw error;
  }
};

// Періодичне очищення старих замовлень та бронювань (кожні 10 хвилин)
setInterval(() => {
  clearOldReservations();
}, 10 * 60 * 1000); // 10 хвилин

// Обробка вебхука від Monobank для прямого платежу
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Бот працює!');
});

// Закоментовано обробку вебхука для "Прямого платежу"
// app.post('/monobank', (req, res) => {
//   // Код для обробки вебхука
// });

app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'success.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
});
