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
    CREATE TABLE IF NOT EXISTS crash_rounds (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      bet BIGINT NOT NULL,
      crash_at NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      cashout_multiplier NUMERIC,
      payout BIGINT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mines_games (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      bet BIGINT NOT NULL,
      bombs INTEGER NOT NULL,
      bomb_cells JSONB NOT NULL,
      revealed_cells JSONB NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

// ===== Игровые константы =====

const CRASH_GROWTH_RATE = 0.9; // рост множителя в секунду (линейный)
const CRASH_HOUSE_EDGE = 0.02; // 2% преимущество площадки
const MINES_HOUSE_EDGE = 0.02;
const MINES_TOTAL_CELLS = 25;

// Генерация крашпоинта с house edge (стандартная формула crash-игр)
function generateCrashPoint(edge = CRASH_HOUSE_EDGE) {
  const r = Math.random();
  const raw = (1 - edge) / (1 - r);
  return Math.min(1000, Math.max(1, Math.floor(raw * 100) / 100));
}

// Честный множитель для Мин с учётом house edge
function minesMultiplier(revealed: number, bombs: number) {
  let mult = 1;
  for (let i = 0; i < revealed; i++) {
    mult *= (MINES_TOTAL_CELLS - i) / (MINES_TOTAL_CELLS - bombs - i);
  }
  return Number((mult * (1 - MINES_HOUSE_EDGE)).toFixed(4));
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

// ===== Краш =====

app.post('/api/games/crash/bet', async (req: any, reply) => {
  let client: any = null;
  try {
    const telegramId = auth(req);
    const u = await user(telegramId);
    const amount = Number((req.body || {}).bet);

    if (!amount || amount < 1) {
      return reply.code(400).send({ error: 'Некорректная ставка' });
    }
    if (Number(u.balance) < amount) {
      return reply.code(400).send({ error: 'Недостаточно листиков' });
    }

    const existing = await pool.query(
      `SELECT id FROM crash_rounds WHERE user_id = $1 AND status = 'active'`,
      [u.id]
    );
    if (existing.rows.length > 0) {
      return reply.code(400).send({ error: 'У тебя уже есть активная ставка' });
    }

    const crashAt = generateCrashPoint();

    client = await pool.connect();
    await client.query('BEGIN');

    await tx(client, u.id, -amount, 'crash_bet', { crashAt });

    const roundResult = await client.query(
      `
      INSERT INTO crash_rounds (user_id, bet, crash_at, status, started_at)
      VALUES ($1, $2, $3, 'active', NOW())
      RETURNING id, started_at
    `,
      [u.id, amount, crashAt]
    );

    await client.query('COMMIT');

    const updated = await user(telegramId);
    return {
      balance: Number(updated.balance),
      roundId: roundResult.rows[0].id,
      startedAt: roundResult.rows[0].started_at,
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

app.post('/api/games/crash/cashout', async (req: any, reply) => {
  let client: any = null;
  try {
    const telegramId = auth(req);
    const u = await user(telegramId);

    const roundResult = await pool.query(
      `
      SELECT *
      FROM crash_rounds
      WHERE user_id = $1
      AND status = 'active'
      ORDER BY id DESC
      LIMIT 1
    `,
      [u.id]
    );

    const round = roundResult.rows[0];
    if (!round) {
      return reply.code(400).send({ error: 'Нет активной ставки' });
    }

    const elapsed = (Date.now() - new Date(round.started_at).getTime()) / 1000;
    const currentMultiplier = 1 + elapsed * CRASH_GROWTH_RATE;
    const crashAt = Number(round.crash_at);

    client = await pool.connect();
    await client.query('BEGIN');

    if (currentMultiplier >= crashAt) {
      await client.query(
        `UPDATE crash_rounds SET status = 'busted' WHERE id = $1`,
        [round.id]
      );
      await client.query('COMMIT');
      return reply.code(400).send({
        error: 'Раунд уже разбился',
        crashed: true,
        crashAt,
      });
    }

    const payout = Math.floor(Number(round.bet) * currentMultiplier);

    await tx(client, u.id, payout, 'crash_cashout', {
      multiplier: currentMultiplier,
      roundId: round.id,
    });

    await client.query(
      `
      UPDATE crash_rounds
      SET status = 'cashed', cashout_multiplier = $1, payout = $2
      WHERE id = $3
    `,
      [currentMultiplier, payout, round.id]
    );

    await client.query('COMMIT');

    const updated = await user(telegramId);
    return {
      balance: Number(updated.balance),
      win: payout,
      multiplier: Number(currentMultiplier.toFixed(2)),
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

// ===== Мины =====

app.post('/api/games/mines', async (req: any, reply) => {
  let client: any = null;
  try {
    const telegramId = auth(req);
    const u = await user(telegramId);
    const amount = Number((req.body || {}).bet);
    const bombs = Number((req.body || {}).mines);

    if (!amount || amount < 1) {
      return reply.code(400).send({ error: 'Некорректная ставка' });
    }
    if (!bombs || bombs < 1 || bombs > 24) {
      return reply.code(400).send({ error: 'Некорректное число бомб' });
    }
    if (Number(u.balance) < amount) {
      return reply.code(400).send({ error: 'Недостаточно листиков' });
    }

    const existing = await pool.query(
      `SELECT id FROM mines_games WHERE user_id = $1 AND status = 'active'`,
      [u.id]
    );
    if (existing.rows.length > 0) {
      return reply.code(400).send({ error: 'У тебя уже есть активная игра' });
    }

    const positions = Array.from({ length: MINES_TOTAL_CELLS }, (_, i) => i);
    for (let i = positions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    const bombCells = positions.slice(0, bombs);

    client = await pool.connect();
    await client.query('BEGIN');

    await tx(client, u.id, -amount, 'mines_bet', { bombs });

    const gameResult = await client.query(
      `
      INSERT INTO mines_games (user_id, bet, bombs, bomb_cells, revealed_cells, status)
      VALUES ($1, $2, $3, $4, '[]', 'active')
      RETURNING id
    `,
      [u.id, amount, bombs, JSON.stringify(bombCells)]
    );

    await client.query('COMMIT');

    const updated = await user(telegramId);
    return {
      balance: Number(updated.balance),
      gameId: gameResult.rows[0].id,
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

app.post('/api/games/mines/:id/open', async (req: any, reply) => {
  try {
    const telegramId = auth(req);
    const u = await user(telegramId);
    const cellIndex = Number((req.body || {}).cell);

    const gameResult = await pool.query(
      `
      SELECT *
      FROM mines_games
      WHERE id = $1
      AND user_id = $2
      AND status = 'active'
    `,
      [req.params.id, u.id]
    );

    const game = gameResult.rows[0];
    if (!game) {
      return reply.code(404).send({ error: 'Игра не найдена' });
    }

    const bombCells: number[] = game.bomb_cells;
    const revealed: number[] = game.revealed_cells || [];

    if (revealed.includes(cellIndex)) {
      return reply.code(400).send({ error: 'Клетка уже открыта' });
    }

    if (bombCells.includes(cellIndex)) {
      await pool.query(
        `UPDATE mines_games SET status = 'lost' WHERE id = $1`,
        [game.id]
      );
      const updated = await user(telegramId);
      return {
        balance: Number(updated.balance),
        lost: true,
        bombCells,
      };
    }

    const newRevealed = [...revealed, cellIndex];
    const multiplier = minesMultiplier(newRevealed.length, Number(game.bombs));

    await pool.query(
      `UPDATE mines_games SET revealed_cells = $1 WHERE id = $2`,
      [JSON.stringify(newRevealed), game.id]
    );

    const updated = await user(telegramId);
    return {
      balance: Number(updated.balance),
      lost: false,
      state: { revealed: newRevealed, multiplier },
    };
  } catch (error: any) {
    return reply.code(error.statusCode || 500).send({
      error: error.message || 'Ошибка',
    });
  }
});

app.post('/api/games/mines/:id/cashout', async (req: any, reply) => {
  let client: any = null;
  try {
    const telegramId = auth(req);
    const u = await user(telegramId);

    const gameResult = await pool.query(
      `
      SELECT *
      FROM mines_games
      WHERE id = $1
      AND user_id = $2
      AND status = 'active'
    `,
      [req.params.id, u.id]
    );

    const game = gameResult.rows[0];
    if (!game) {
      return reply.code(404).send({ error: 'Игра не найдена' });
    }

    const revealed: number[] = game.revealed_cells || [];
    if (revealed.length === 0) {
      return reply.code(400).send({ error: 'Сначала открой хотя бы одну клетку' });
    }

    const multiplier = minesMultiplier(revealed.length, Number(game.bombs));
    const payout = Math.floor(Number(game.bet) * multiplier);

    client = await pool.connect();
    await client.query('BEGIN');

    await tx(client, u.id, payout, 'mines_cashout', {
      gameId: game.id,
      multiplier,
    });

    await client.query(
      `UPDATE mines_games SET status = 'cashed' WHERE id = $1`,
      [game.id]
    );

    await client.query('COMMIT');

    const updated = await user(telegramId);
    return {
      balance: Number(updated.balance),
      win: payout,
      multiplier,
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
