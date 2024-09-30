require('dotenv').config()
const TelegramBot = require('node-telegram-bot-api')
const axios = require('axios')
const express = require('express')
const qr = require('qr-image')
const fs = require('fs')
const path = require('path')

const token = process.env.TELEGRAM_BOT_TOKEN
const monoMerchantToken = process.env.MONOBANK_MERCHANT_TOKEN

const bot = new TelegramBot(token, { polling: true })

const events = [
    { id: 1, name: 'Концерт А', price: 500 }, // Ціна в копійках (UAH)
    { id: 2, name: 'Фестиваль Б', price: 75000 },
]

const orders = {} // Масив для збереження замовлень
const userStates = {} // Об'єкт для зберігання станів користувачів

// Обробка команди /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id

    const mainMenu = {
        reply_markup: {
            keyboard: [[{ text: '🎫 Доступні івенти' }], [{ text: 'ℹ️ Допомога' }]],
            resize_keyboard: true,
            one_time_keyboard: false,
        },
    }

    bot.sendMessage(chatId, 'Вітаємо! Оберіть опцію з меню:', mainMenu)

    userStates[chatId] = { state: 'main_menu' }
})

function getTitle(text) {
    // Використовуємо регулярний вираз для вилучення тексту до першого дефісу
    const match = text.match(/^[^-]+/);
    return match ? match[0].trim() : '';
  }

// Обробка повідомлень від користувача
bot.on('message', (msg) => {
    const chatId = msg.chat.id
    const text = msg.text
    // console.log(msg)

    // Ініціалізація стану користувача, якщо його ще немає
    if (!userStates[chatId]) {
        userStates[chatId] = { state: 'main_menu' }
    }

    const userState = userStates[chatId]

    if (text === '🎫 Доступні івенти') {
        // Відображаємо список івентів через клавіатуру-відповідь
        const eventButtons = events.map((event) => {
            return [{ text: `${event.name} - ${event.price / 100} грн.`}]
        })

        const options = {
            reply_markup: {
                keyboard: eventButtons,
                resize_keyboard: true,
                one_time_keyboard: true,
            },
        }

        bot.sendMessage(chatId, 'Оберіть івент:', options)

        // Оновлюємо стан користувача
        userState.state = 'selecting_event'
    } else if (userState.state === 'selecting_event') {
        // Перевіряємо, чи введений текст відповідає назві івенту

        const selectedEvent = events.find((event) => event.name === getTitle(text))
        if (selectedEvent) {
            userState.selectedEvent = selectedEvent

            // Пропонуємо вибрати кількість квитків
            const quantityButtons = []
            for (let i = 1; i <= 5; i++) {
                quantityButtons.push([{ text: `${i}` }])
            }

            const options = {
                reply_markup: {
                    keyboard: quantityButtons,
                    resize_keyboard: true,
                    one_time_keyboard: true,
                },
            }

            bot.sendMessage(chatId, `Виберіть кількість квитків на *${selectedEvent.name}*:`, {
                parse_mode: 'Markdown',
                ...options,
            })

            userState.state = 'selecting_quantity'
        } else {
            bot.sendMessage(chatId, '❗️ Обраний івент не знайдено. Будь ласка, оберіть зі списку.')
        }
    } else if (userState.state === 'selecting_quantity') {
        const quantity = parseInt(text)
        if (!isNaN(quantity) && quantity >= 1 && quantity <= 5) {
            const selectedEvent = userState.selectedEvent
            const totalPrice = selectedEvent.price * quantity

            try {
                const reference = `ticket_${selectedEvent.id}_${chatId}_${Date.now()}`

                // Збереження замовлення
                orders[reference] = {
                    chatId: chatId,
                    eventId: selectedEvent.id,
                    quantity: quantity,
                }

                const paymentData = {
                    amount: totalPrice,
                    ccy: 980,
                    merchantPaymInfo: {
                        reference: reference,
                        destination: `Оплата ${quantity} квитків на ${selectedEvent.name}`,
                    },
                    redirectUrl: 'https://be0f-31-41-95-40.ngrok-free.app/success', // Ваш фактичний redirectUrl
                    webHookUrl: 'https://be0f-31-41-95-40.ngrok-free.app/monobank', // Ваш фактичний webHookUrl
                }

                axios
                    .post('https://api.monobank.ua/api/merchant/invoice/create', paymentData, {
                        headers: {
                            'X-Token': monoMerchantToken,
                            'Content-Type': 'application/json',
                        },
                    })
                    .then((response) => {
                        const { invoiceId, pageUrl } = response.data

                        bot.sendMessage(
                            chatId,
                            `Для оплати ${quantity} квитків на *${selectedEvent.name}* перейдіть за посиланням:\n${pageUrl}`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    remove_keyboard: true,
                                },
                            }
                        )

                        // Скидаємо стан користувача
                        userStates[chatId] = { state: 'main_menu' }
                    })
                    .catch((error) => {
                        console.error(error)
                        bot.sendMessage(chatId, '❗️ Сталася помилка при створенні рахунку. Спробуйте пізніше.')
                        userStates[chatId] = { state: 'main_menu' }
                    })
            } catch (error) {
                console.error(error)
                bot.sendMessage(chatId, '❗️ Сталася помилка. Спробуйте пізніше.')
                userStates[chatId] = { state: 'main_menu' }
            }
        } else {
            bot.sendMessage(chatId, '❗️ Будь ласка, оберіть кількість квитків від 1 до 5.')
        }
    } else if (text === 'ℹ️ Допомога') {
        bot.sendMessage(
            chatId,
            'Це бот для придбання квитків на музичні івенти. Оберіть "🎫 Доступні івенти", щоб переглянути список.'
        )
    } else {
        // bot.sendMessage(chatId, 'Невідома команда. Будь ласка, оберіть опцію з меню.')
    }
})

// Обробка вебхука від Monobank
const app = express()
app.use(express.json())

app.post('/monobank', (req, res) => {
    const data = req.body

    if (data.status === 'success') {
        const reference = data.reference
        const order = orders[reference]

        console.log('Отримано вебхук від Monobank:', data, order)

        if (order) {
            const chatId = order.chatId
            const eventId = order.eventId
            const quantity = order.quantity
            const selectedEvent = events.find((event) => event.id === eventId)

            // Генерація та відправка квитків
            for (let i = 1; i <= quantity; i++) {
                // Унікальний код для кожного квитка
                const ticketCode = `${reference}_${i}`

                // Інформація про квиток
                const ticketInfo = `Квиток №${i} на ${selectedEvent.name}\nУнікальний код: ${ticketCode}`

                // Генерація QR-коду
                const qr_png = qr.image(ticketInfo, { type: 'png' })
                const qrPath = path.join(__dirname, `${ticketCode}.png`)
                const writeStream = fs.createWriteStream(qrPath)

                qr_png.pipe(writeStream)

                writeStream.on('finish', () => {
                    // Відправка квитка користувачу
                    bot.sendPhoto(chatId, qrPath, {
                        caption: `✅ Ваш квиток №${i} на *${selectedEvent.name}*.`,
                        parse_mode: 'Markdown',
                    })
                        .then(() => {
                            // Видалення тимчасового файлу з QR-кодом
                            fs.unlinkSync(qrPath)
                        })
                        .catch((err) => {
                            console.error('Помилка при відправці квитка:', err)
                        })
                })
            }

            // Надсилаємо повідомлення після відправки всіх квитків
            bot.sendMessage(chatId, '✅ Дякуємо за покупку! Всі ваші квитки були надіслані.', {
                reply_markup: {
                    keyboard: [[{ text: '🎫 Доступні івенти' }], [{ text: 'ℹ️ Допомога' }]],
                    resize_keyboard: true,
                    one_time_keyboard: false,
                },
            })

            // Видалення замовлення з пам'яті
            delete orders[reference]
        } else {
            console.error('Замовлення не знайдено для reference:', reference)
        }
    }

    res.sendStatus(200)
})

app.get('/success', (req, res) => {
    res.sendFile(path.join(__dirname, 'success.html'))
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`)
})
