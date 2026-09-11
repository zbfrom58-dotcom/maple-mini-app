import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Pool } from 'pg';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const app = Fastify({ logger: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const botToken = process.env.BOT_TOKEN;
const adminKey = process.env.ADMIN_KEY || 'change_me';

if (!botToken) {
  throw new Error('BOT_TOKEN не найден в переменных Railway');
}

app.register(fastifyStatic, {
  root: path.join(process.cwd(), 'public'),
});

app.get('/', async (_, reply) => {
  return reply.sendFile('index.html');
});

// Создаём таблицы при запуске
async function prepareDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_orders (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      payload TEXT UNIQUE NOT NULL,
      stars INTEGER NOT NULL,
      leaves BIGINT NOT NULL,
      telegram_payment_charge_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    INSERT INTO shop_packages (leaves, stars, active)
    VALUES
      (100000, 50, true),
      (220000, 100, true),
      (1200000, 500, true),
      (3000000, 1000, true)
    ON CONFLICT DO NOTHING
  `);
}

// Получаем настоящий Telegram ID
function auth(req: any): string {
  const tgId = req.headers['x-telegram-id'];
  if (!tgId) {
    const error: any = new Error(
      'Открой приложение через Telegram'
    );
    error.statusCode = 401;
    throw error;
  }
  return String(tgId);
}

// Получаем или создаём пользователя
async function user(telegramId: string) {
  const result = await pool.query(
    `
    INSERT INTO users (telegram_id, balance)
    VALUES ($1, 0)
    ON CONFLICT (telegram_id)
    DO UPDATE SET telegram_id = EXCLUDED.telegram_id
    RETURNING *
  `,
    [telegramId]
  );
  return result.rows[0];
}

// Изменение баланса и запись операции
async function tx(
  client: any,
  userId: number,
  amount: number,
  type: string,
  meta: Record<string, any> = {}
) {
  await client.query(
    `
    UPDATE users
    SET balance = balance + $1
    WHERE id = $2
  `,
    [amount, userId]
  );

  await client.query(
    `
    INSERT INTO transactions (user_id, amount, type, meta)
    VALUES ($1, $2, $3, $4)
  `,
    [userId, amount, type, JSON.stringify(meta)]
  );
}

// Данные пользователя
app.get('/api/me', async (req: any, reply) => {
  try {
    const telegramId = auth(req);
    const u = await user(telegramId);
    return {
      id: u.telegram_id,
      balance: Number(u.balance),
      firstName: u.first_name || 'Игрок',
    };
  } catch (error: any) {
    return reply.code(error.statusCode || 500).send({
      error: error.message || 'Ошибка',
    });
  }
});

// Ежедневный бонус
app.post('/api/daily', async (req: any, reply) => {
  let client: any = null;
  try {
    const telegramId = auth(req);
    const u = await user(telegramId);

    const canReceive =
      !u.last_daily_at ||
      Date.now() - new Date(u.last_daily_at).getTime() > 86400000;

    if (!canReceive) {
      return reply.code(400).send({
        error: 'Бонус уже получен',
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    await client.query(
      `
      UPDATE users
      SET last_daily_at = NOW()
      WHERE id = $1
    `,
      [u.id]
    );

    await tx(client, u.id, 2500, 'daily');
    await client.query('COMMIT');

    const updated = await user(telegramId);
    return {
      balance: Number(updated.balance),
      reward: 2500,
    };
  } catch (error: any) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    return reply.code(error.statusCode || 500).send({
      error: error.message || 'Ошибка',
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Список заданий
app.get('/api/tasks', async (req: any, reply) => {
  try {
    const u = await user(auth(req));
    const result = await pool.query(
      `
      SELECT
        t.*,
        c.created_at AS completed_at
      FROM tasks t
      LEFT JOIN task_completions c
        ON c.task_id = t.id
        AND c.user_id = $1
      WHERE t.active = true
      ORDER BY t.id
    `,
      [u.id]
    );
    return result.rows;
  } catch (error: any) {
    return reply.code(error.statusCode || 500).send({
      error: error.message || 'Ошибка',
    });
  }
});

// Получение награды за задание
app.post('/api/tasks/:id/claim', async (req: any, reply) => {
  let client: any = null;
  try {
    const telegramId = auth(req);
    const u = await user(telegramId);

    client = await pool.connect();

    const taskResult = await client.query(
      `
      SELECT *
      FROM tasks
      WHERE id = $1
      AND active = true
    `,
      [req.params.id]
    );

    const task = taskResult.rows[0];
    if (!task) {
      return reply.code(404).send({
        error: 'Задание не найдено',
      });
    }

    const completedResult = await client.query(
      `
      SELECT 1
      FROM task_completions
      WHERE user_id = $1
      AND task_id = $2
    `,
      [u.id, task.id]
    );

    if (completedResult.rows.length > 0) {
      return reply.code(400).send({
        error: 'Задание уже выполнено',
      });
    }

    await client.query('BEGIN');

    await client.query(
      `
      INSERT INTO task_completions (user_id, task_id)
      VALUES ($1, $2)
    `,
      [u.id, task.id]
    );

    await tx(client, u.id, Number(task.reward), 'task', {
      taskId: task.id,
    });

    await client.query('COMMIT');

    const updated = await user(telegramId);
    return {
      balance: Number(updated.balance),
    };
  } catch (error: any) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    return reply.code(error.statusCode || 500).send({
      error: error.message || 'Ошибка',
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Магазин
app.get('/api/shop', async (_, reply) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM shop_packages
      WHERE active = true
      ORDER BY stars
    `
    );
    return {
      packages: result.rows,
    };
  } catch (error: any) {
    return reply.code(500).send({
      error: error.message || 'Ошибка магазина',
    });
  }
});

// Создание счёта Telegram Stars
app.post('/api/shop/invoice', async (req: any, reply) => {
  try {
    const telegramId = auth(req);
    const { stars } = req.body || {};
    const numericStars = Number(stars);

    const packageResult = await pool.query(
      `
      SELECT *
      FROM shop_packages
      WHERE stars = $1
      AND active = true
      LIMIT 1
    `,
      [numericStars]
    );

    const selectedPackage = packageResult.rows[0];
    if (!selectedPackage) {
      return reply.code(400).send({
        error: 'Такого набора нет',
      });
    }

    const payload = JSON.stringify({
      telegramId,
      stars: Number(selectedPackage.stars),
      leaves: Number(selectedPackage.leaves),
      createdAt: Date.now(),
    });

    await pool.query(
      `
      INSERT INTO payment_orders (
        telegram_id,
        payload,
        stars,
        leaves
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (payload) DO NOTHING
    `,
      [
        telegramId,
        payload,
        Number(selectedPackage.stars),
        Number(selectedPackage.leaves),
      ]
    );

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/createInvoiceLink`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: `${selectedPackage.leaves} листиков`,
          description: `Покупка ${selectedPackage.leaves} кленовых листиков`,
          payload,
          currency: 'XTR',
          prices: [
            {
              label: `${selectedPackage.leaves} листиков`,
              amount: Number(selectedPackage.stars),
            },
          ],
        }),
      }
    );

    const result: any = await telegramResponse.json();
    if (!result.ok) {
      return reply.code(500).send({
        error: result.description || 'Не удалось создать счёт',
      });
    }

    return {
      invoiceLink: result.result,
    };
  } catch (error: any) {
    return reply.code(error.statusCode || 500).send({
      error: error.message || 'Ошибка оплаты',
    });
  }
});

// Webhook Telegram для подтверждения платежей и /start
app.post('/telegram/webhook', async (req: any, reply) => {
  try {
    const update = req.body || {};

    // Обработка обычных сообщений (например, /start)
    const message = update.message;
    if (message && message.text) {
      const chatId = message.chat.id;
      const text = message.text.trim();

      if (text === '/start' || text.startsWith('/start ')) {
        const webAppUrl = process.env.WEBAPP_URL;

        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '🍁 Добро пожаловать в «Кленовый листик»!\n\nЗдесь ты можешь:\n— выполнять задания и получать листики\n— играть в Мины и Краш\n— приглашать друзей и зарабатывать на рефералах\n— обменивать листики на NFT-подарки\n\nЖми «Играть», чтобы начать!',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🍁 Играть',
                    web_app: { url: webAppUrl },
                  },
                ],
              ],
            },
          }),
        });

        return { ok: true };
      }
    }

    // Telegram спрашивает, можно ли провести платёж
    if (update.pre_checkout_query) {
      const query = update.pre_checkout_query;
      await fetch(
        `https://api.telegram.org/bot${botToken}/answerPreCheckoutQuery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            pre_checkout_query_id: query.id,
            ok: true,
          }),
        }
      );
      return { ok: true };
    }

    // Telegram сообщает об успешной оплате
    const payment =
      update.message?.successful_payment || update.successful_payment;

    if (payment) {
      const payload = payment.invoice_payload;

      const orderResult = await pool.query(
        `
        SELECT *
        FROM payment_orders
        WHERE payload = $1
        LIMIT 1
      `,
        [payload]
      );

      const order = orderResult.rows[0];
      if (!order) {
        return { ok: true };
      }

      // Если уже начисляли — повторно не начисляем
      if (order.status === 'paid') {
        return { ok: true };
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const lockedOrderResult = await client.query(
          `
          SELECT *
          FROM payment_orders
          WHERE id = $1
          FOR UPDATE
        `,
          [order.id]
        );

        const lockedOrder = lockedOrderResult.rows[0];

        if (lockedOrder.status === 'paid') {
          await client.query('COMMIT');
          return { ok: true };
        }

        const u = await user(lockedOrder.telegram_id);

        await tx(client, u.id, Number(lockedOrder.leaves), 'stars_purchase', {
          stars: Number(lockedOrder.stars),
          leaves: Number(lockedOrder.leaves),
          paymentId: payment.telegram_payment_charge_id,
        });

        await client.query(
          `
          UPDATE payment_orders
          SET
            status = 'paid',
            telegram_payment_charge_id = $1,
            paid_at = NOW()
          WHERE id = $2
        `,
          [payment.telegram_payment_charge_id, lockedOrder.id]
        );

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    return { ok: true };
  } catch (error) {
    app.log.error(error);
    return { ok: false };
  }
});

// Админ: список заданий
app.get('/api/admin/tasks', async (req: any, reply) => {
  if (req.headers['x-admin-key'] !== adminKey) {
    return reply.code(401).send({
      error: 'Нет доступа',
    });
  }

  const result = await pool.query('SELECT * FROM tasks ORDER BY id DESC');
  return result.rows;
});

// Админ: создание задания
app.post('/api/admin/tasks', async (req: any, reply) => {
  if (req.headers['x-admin-key'] !== adminKey) {
    return reply.code(401).send({
      error: 'Нет доступа',
    });
  }

  const { title, description = '', channelUrl = '', reward = 10000 } =
    req.body || {};

  if (!title) {
    return reply.code(400).send({
      error: 'Название задания обязательно',
    });
  }

  const result = await pool.query(
    `
    INSERT INTO tasks (
      title,
      description,
      channel_url,
      reward,
      active
    )
    VALUES ($1, $2, $3, $4, true)
    RETURNING *
  `,
    [title, description, channelUrl, Number(reward)]
  );

  return result.rows[0];
});

// Проверка сервера
app.get('/health', async () => {
  return {
    ok: true,
  };
});

// Запуск
async function start() {
  try {
    await prepareDatabase();
    await app.listen({
      port: Number(process.env.PORT || 3000),
      host: '0.0.0.0',
    });
    app.log.info('Maple Mini App запущен');
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();
