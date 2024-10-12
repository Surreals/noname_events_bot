require('dotenv').config()
const TelegramBot = require('node-telegram-bot-api')
const axios = require('axios')
const express = require('express')
const qr = require('qr-image')
const fs = require('fs')
const path = require('path')
const winston = require('winston')

// Налаштування логера
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}] ${message}`
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'bot.log' })
    ],
})

const token = process.env.TELEGRAM_BOT_TOKEN
const monoMerchantToken = process.env.MONOBANK_MERCHANT_TOKEN

const bot = new TelegramBot(token, { polling: true })

const events = [
    { id: 1, name: 'Концерт А', price: 500 }, // Ціна в копійках (UAH)
    { id: 2, name: 'Фестиваль Б', price: 75000 },
]

// Шляхи до файлів
const ordersFilePath = path.join(__dirname, 'orders.json')
const userStatesFilePath = path.join(__dirname, 'userStates.json')

// Функція для завантаження даних з файлу
function loadData(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8')
            return JSON.parse(data)
        } else {
            return {}
        }
    } catch (error) {
        logger.error(`Помилка при завантаженні даних з файлу ${filePath}: ${error}`)
        return {}
    }
}

// Функція для збереження даних у файл
function saveData(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    } catch (error) {
        logger.error(`Помилка при збереженні даних у файл ${filePath}: ${error}`)
    }
}

// Завантажуємо дані при старті сервера
let orders = loadData(ordersFilePath)
let userStates = loadData(userStatesFilePath)

// Змінна для зберігання попереднього балансу банки
let previousJarAmount = 0

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
    saveData(userStatesFilePath, userStates)
})

function getTitle(text) {
    const match = text.match(/^[^-]+/)
    return match ? match[0].trim() : ''
}

bot.on('message', (msg) => {
    const chatId = msg.chat.id
    const text = msg.text

    if (!userStates[chatId]) {
        userStates[chatId] = { state: 'main_menu' }
        saveData(userStatesFilePath, userStates)
    }

    const userState = userStates[chatId]

    if (text === '🎫 Доступні івенти') {
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

        userState.state = 'selecting_event'
        userStates[chatId] = userState
        saveData(userStatesFilePath, userStates)
    } else if (userState.state === 'selecting_event') {
        const selectedEvent = events.find((event) => event.name === getTitle(text))
        if (selectedEvent) {
            userState.selectedEvent = selectedEvent

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
            userStates[chatId] = userState
            saveData(userStatesFilePath, userStates)
        } else {
            bot.sendMessage(chatId, '❗️ Обраний івент не знайдено. Будь ласка, оберіть зі списку.')
        }
    } else if (userState.state === 'selecting_quantity') {
        const quantity = parseInt(text)
        if (!isNaN(quantity) && quantity >= 1 && quantity <= 5) {
            const selectedEvent = userState.selectedEvent
            userState.quantity = quantity

            const paymentMethodButtons = [
                [{ text: '💳 Прямий платіж' }],
                [{ text: '💰 Оплата на банку' }]
            ]

            const options = {
                reply_markup: {
                    keyboard: paymentMethodButtons,
                    resize_keyboard: true,
                    one_time_keyboard: true,
                },
            }

            bot.sendMessage(chatId, 'Оберіть спосіб оплати:', options)

            userState.state = 'selecting_payment_method'
            userStates[chatId] = userState
            saveData(userStatesFilePath, userStates)
        } else {
            bot.sendMessage(chatId, '❗️ Будь ласка, оберіть кількість квитків від 1 до 5.')
        }
    } else if (userState.state === 'selecting_payment_method') {
        const paymentMethod = text

        if (paymentMethod === '💳 Прямий платіж') {
            const selectedEvent = userState.selectedEvent
            const quantity = userState.quantity
            const totalPrice = selectedEvent.price * quantity

            try {
                const reference = `ticket_${selectedEvent.id}_${chatId}_${Date.now()}`

                orders[reference] = {
                    chatId: chatId,
                    eventId: selectedEvent.id,
                    quantity: quantity,
                }
                saveData(ordersFilePath, orders)

                const paymentData = {
                    amount: totalPrice,
                    ccy: 980,
                    merchantPaymInfo: {
                        reference: reference,
                        destination: `Оплата ${quantity} квитків на ${selectedEvent.name}`,
                    },
                    redirectUrl: 'https://nndvizh.site/success',
                    webHookUrl: 'https://nndvizh.site/monobank',
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

                        userStates[chatId] = { state: 'main_menu' }
                        saveData(userStatesFilePath, userStates)
                    })
                    .catch((error) => {
                        logger.error(`Помилка при створенні рахунку: ${error}`)
                        bot.sendMessage(chatId, '❗️ Сталася помилка при створенні рахунку. Спробуйте пізніше.')
                        userStates[chatId] = { state: 'main_menu' }
                        saveData(userStatesFilePath, userStates)
                    })
            } catch (error) {
                logger.error(`Помилка: ${error}`)
                bot.sendMessage(chatId, '❗️ Сталася помилка. Спробуйте пізніше.')
                userStates[chatId] = { state: 'main_menu' }
                saveData(userStatesFilePath, userStates)
            }
        } else if (paymentMethod === '💰 Оплата на банку') {
            const selectedEvent = userState.selectedEvent
            const quantity = userState.quantity
            const totalPrice = selectedEvent.price * quantity
            const totalPriceGrn = totalPrice / 100

            const reference = `jar_${selectedEvent.id}_${chatId}_${Date.now()}`
            userState.orderInfo = {
                chatId: chatId,
                eventId: selectedEvent.id,
                quantity: quantity,
                totalPrice: totalPriceGrn,
                reference: reference,
                paymentConfirmed: false,
            }

            orders[reference] = userState.orderInfo
            saveData(ordersFilePath, orders)

            getJarAmount().then((amount) => {
                previousJarAmount = amount

                bot.sendMessage(
                    chatId,
                    `Для оплати ${quantity} квитків на *${selectedEvent.name}* на суму ${totalPriceGrn} грн перейдіть за посиланням:\nhttps://send.monobank.ua/jar/AB3wzETu3o`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            remove_keyboard: true,
                        },
                    }
                )

                bot.sendMessage(chatId, 'Після здійснення оплати, натисніть "✅ Я оплатив", щоб отримати квитки.', {
                    reply_markup: {
                        keyboard: [[{ text: '✅ Я оплатив' }]],
                        resize_keyboard: true,
                        one_time_keyboard: true,
                    },
                })

                userState.state = 'waiting_for_payment_confirmation'
                userStates[chatId] = userState
                saveData(userStatesFilePath, userStates)
            }).catch((error) => {
                logger.error(`Помилка при отриманні балансу банки: ${error}`)
                bot.sendMessage(chatId, '❗️ Сталася помилка. Спробуйте пізніше.')
                userStates[chatId] = { state: 'main_menu' }
                saveData(userStatesFilePath, userStates)
            })
        } else {
            bot.sendMessage(chatId, '❗️ Будь ласка, оберіть спосіб оплати зі списку.')
        }
    } else if (userState.state === 'waiting_for_payment_confirmation') {
        if (text === '✅ Я оплатив') {
            const orderInfo = userState.orderInfo

            checkJarPayment(orderInfo.totalPrice).then((paymentConfirmed) => {
                if (paymentConfirmed) {
                    const selectedEvent = events.find((event) => event.id === orderInfo.eventId)
                    const quantity = orderInfo.quantity
                    const reference = orderInfo.reference

                    for (let i = 1; i <= quantity; i++) {
                        const ticketCode = `${reference}_${i}`
                        const ticketInfo = `Квиток №${i} на ${selectedEvent.name}\nУнікальний код: ${ticketCode}`

                        const qr_png = qr.image(ticketInfo, { type: 'png' })
                        const qrPath = path.join(__dirname, `${ticketCode}.png`)
                        const writeStream = fs.createWriteStream(qrPath)

                        qr_png.pipe(writeStream)

                        writeStream.on('finish', () => {
                            bot.sendPhoto(orderInfo.chatId, qrPath, {
                                caption: `✅ Ваш квиток №${i} на *${selectedEvent.name}*.`,
                                parse_mode: 'Markdown',
                            })
                                .then(() => {
                                    fs.unlinkSync(qrPath)
                                })
                                .catch((err) => {
                                    logger.error(`Помилка при відправці квитка: ${err}`)
                                })
                        })
                    }

                    bot.sendMessage(orderInfo.chatId, '✅ Дякуємо за покупку! Всі ваші квитки були надіслані.', {
                        reply_markup: {
                            keyboard: [[{ text: '🎫 Доступні івенти' }], [{ text: 'ℹ️ Допомога' }]],
                            resize_keyboard: true,
                            one_time_keyboard: false,
                        },
                    })

                    userStates[chatId] = { state: 'main_menu' }
                    saveData(userStatesFilePath, userStates)
                    delete orders[reference]
                    saveData(ordersFilePath, orders)
                } else {
                    bot.sendMessage(chatId, '❗️ Оплату не підтверджено. Будь ласка, переконайтеся, що ви здійснили оплату, та спробуйте знову.', {
                        reply_markup: {
                            keyboard: [[{ text: '✅ Я оплатив' }]],
                            resize_keyboard: true,
                            one_time_keyboard: true,
                        },
                    })
                }
            }).catch((error) => {
                logger.error(`Помилка при перевірці оплати: ${error}`)
                bot.sendMessage(chatId, '❗️ Сталася помилка при перевірці оплати. Спробуйте пізніше.')
            })
        } else {
            bot.sendMessage(chatId, '❗️ Будь ласка, натисніть "✅ Я оплатив" після здійснення оплати.', {
                reply_markup: {
                    keyboard: [[{ text: '✅ Я оплатив' }]],
                    resize_keyboard: true,
                    one_time_keyboard: true,
                },
            })
        }
    } else if (text === 'ℹ️ Допомога') {
        bot.sendMessage(
            chatId,
            'Це бот для придбання квитків на музичні івенти. Оберіть "🎫 Доступні івенти", щоб переглянути список.'
        )
    } else {
        // Інші випадки або невідомі команди
    }
})

// Функція для отримання балансу банки
async function getJarAmount() {
    try {
        const response = await axios.post('https://send.monobank.ua/api/handler', {
            Pc: "BJR6mYIOGCZLbsfKoLtngOGVPTYJMPoxYAxipw4LfywhDJjJZGSuxfc6g6q/8dxzbEHM8ygdEMEyev30jYE/GA4=",
            c: "hello",
            clientId: "AB3wzETu3o",
            referer: ""
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        })

        const data = response.data

        if (data && data.jarAmount !== undefined) {
            return parseFloat(data.jarAmount)
        } else {
            throw new Error('jarAmount не знайдено у відповіді')
        }
    } catch (error) {
        logger.error(`Помилка при отриманні балансу банки: ${error}`)
        throw error
    }
}

// Функція для перевірки оплати
async function checkJarPayment(expectedAmount) {
    try {
        const currentAmount = await getJarAmount()
        const amountDifference = currentAmount - previousJarAmount

        logger.info(`Попередній баланс: ${previousJarAmount}, поточний баланс: ${currentAmount}, різниця: ${amountDifference}`)

        if (amountDifference >= expectedAmount) {
            previousJarAmount = currentAmount
            return true
        } else {
            return false
        }
    } catch (error) {
        logger.error(`Помилка при перевірці оплати: ${error}`)
        throw error
    }
}

// Обробка вебхука від Monobank для прямого платежу
const app = express()
app.use(express.json())

app.get('/', (req, res) => {
    res.send('Бот працює!')
})

app.post('/monobank', (req, res) => {
    const data = req.body

    if (data.status === 'success') {
        const reference = data.reference
        const order = orders[reference]

        logger.info(`Отримано вебхук від Monobank: ${JSON.stringify(data)}, замовлення: ${JSON.stringify(order)}`)

        if (order) {
            const chatId = order.chatId
            const eventId = order.eventId
            const quantity = order.quantity
            const selectedEvent = events.find((event) => event.id === eventId)

            for (let i = 1; i <= quantity; i++) {
                const ticketCode = `${reference}_${i}`
                const ticketInfo = `Квиток №${i} на ${selectedEvent.name}\nУнікальний код: ${ticketCode}`

                const qr_png = qr.image(ticketInfo, { type: 'png' })
                const qrPath = path.join(__dirname, `${ticketCode}.png`)
                const writeStream = fs.createWriteStream(qrPath)

                qr_png.pipe(writeStream)

                writeStream.on('finish', () => {
                    bot.sendPhoto(chatId, qrPath, {
                        caption: `✅ Ваш квиток №${i} на *${selectedEvent.name}*.`,
                        parse_mode: 'Markdown',
                    })
                        .then(() => {
                            fs.unlinkSync(qrPath)
                        })
                        .catch((err) => {
                            logger.error(`Помилка при відправці квитка: ${err}`)
                        })
                })
            }

            bot.sendMessage(chatId, '✅ Дякуємо за покупку! Всі ваші квитки були надіслані.', {
                reply_markup: {
                    keyboard: [[{ text: '🎫 Доступні івенти' }], [{ text: 'ℹ️ Допомога' }]],
                    resize_keyboard: true,
                    one_time_keyboard: false,
                },
            })

            delete orders[reference]
            saveData(ordersFilePath, orders)
        } else {
            logger.error(`Замовлення не знайдено для reference: ${reference}`)
        }
    }

    res.sendStatus(200)
})

app.get('/success', (req, res) => {
    res.sendFile(path.join(__dirname, 'success.html'))
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    logger.info(`Server started on port ${PORT}`)
})
