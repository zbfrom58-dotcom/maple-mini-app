# 🍁 Кленовый листик — Telegram Mini App

## Локальный запуск

1. Создай PostgreSQL базу.
2. Скопируй `.env.example` в `.env` и заполни `DATABASE_URL` и `ADMIN_KEY`.
3. Выполни `schema.sql` в базе.
4. Установи Node.js 22+.
5. Выполни:

```bash
npm install
npm run dev
```

Открой `http://localhost:3000`.

## Railway

Подключи GitHub-репозиторий к Railway, добавь PostgreSQL service и переменные окружения из `.env.example`. Railway использует Dockerfile автоматически.

## Админка API

`GET /api/admin/tasks` и `POST /api/admin/tasks` с заголовком `x-admin-key`.

Пример создания задания:

```json
{"title":"Новостной канал","description":"Подпишись на канал","channelUrl":"https://t.me/channel","reward":10000}
```

## Что нужно доделать перед продакшеном

- Проверка Telegram initData на backend.
- Проверка подписки через Telegram Bot API.
- Telegram Stars invoices и обработчики pre_checkout_query / successful_payment.
- Полноценная админ-панель с авторизацией.
- Защита от повторной отправки запросов и аудит игровых раундов.
