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

// ===== Игровые константы и утилиты =====

const MINES_TOTAL_CELLS = 25;
const MINES_HOUSE_EDGE = 0.97; // 3% преимущество казино

// Множитель в игре "Мины" — стандартная комбинаторная формула
function minesMultiplier(minesCount: number, opened: number): number {
  let product = 1;
  for (let i = 0; i < opened; i++) {
    product *= (MINES_TOTAL_CELLS - i) / (MINES_TOTAL_CELLS - minesCount - i);
  }
  return product * MINES_HOUSE_EDGE;
}

// Точка краха для игры "Краш" — экспоненциальное распределение с преимуществом казино 4%
function generateCrashPoint(): number {
  const houseEdge = 0.04;
  if (Math.random() < houseEdge) return 1;
  const scale = 0.9;
  const point = 1 + -Math.log(1 - Math.random()) * scale;
  return Math.min(point, 25);
}

// Текущий множитель краша в момент времени t (та же кривая, что и на клиенте)
function crashCurrentMultiplier(startedAt: Date, crashAt: number): number {
  const t = (Date.now() - startedAt.getTime()) / 1000;
  const m = 1 + Math.pow(t, 1.7) * 2.2;
  return Math.min(m, crashAt);
}

// Каталог NFT-подарков и их цена в листиках
const NFT_CATALOG: Record<string, number> = {
  'vice-143868': 2500000,
  'pool-67988': 2500000,
  'vice-314974': 2500000,
};

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
    CREATE TABLE IF NOT EXISTS mine_games (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      bet BIGINT NOT NULL,
      mines_count INTEGER NOT NULL,
      bomb_cells INTEGER[] NOT NULL,
      opened_cells INTEGER[] NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS crash_rounds (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      bet BIGINT NOT NULL,
      crash_at NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cashout_multiplier NUMERIC
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nft_purchases (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      nft_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, nft_id)
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
    [
      userId,
      amount,
      type,
      JSON.stringify(meta),
    ]
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

// Покупка NFT-подарка за листики
app.post('/api/shop/nft', async (req: any, reply) => {
  let client: any = null;
  try {
    const telegramId = auth(req);
    const u = await user(telegramId);
    const { id } = req.body || {};
    const price = NFT_CATALOG[id];

    if (!price) {
      return reply.code(400).send({
        error: 'Такого подарка нет',
      });
    }

    if (Number(u.balance) < price) {
      return reply.code(400).send({
        error: 'Недостаточно листиков',
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const existing = await client.query(
      `
      SELECT 1
      FROM nft_purchases
      WHERE user_id = $1
      AND nft_id = $2
      `,
      [u.id, id]
    );

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return reply.code(400).send({
        error: 'Подарок уже куплен',
      });
    }

    await client.query(
      `
      INSERT INTO nft_purchases (user_id, nft_id)
      VALUES ($1, $2)
      `,
      [u.id, id]
    );

    await tx(client, u.id, -price, 'nft_purchase', { nftId: id });

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

// ===== Игра "Мины" =====

// Начать игру
app.post('/api/games/mines', async (req: any, reply) => {
  let client: any = null;
  try {
    const telegramId = auth(req);
    const u = await user(telegramId);
    const { bet, mines } = req.body || {};
    const numericBet = Number(bet);
    const numericMines = Number(mines);

    if (!numericBet || numericBet < 1) {
      return reply.code(400).send({ error: 'Некорректная ставка' });
    }
    if (!numericMines || numericMines < 1 || numericMines > 24) {
      return reply.code(400).send({ error: 'Некорректное количество бомб' });
    }
    if (Number(u.balance) < numericBet) {
      return reply.code(400).send({ error: 'Недостаточно листиков' });
    }

    const bombCells: number[] = [];
    while (bombCells.length < numericMines) {
      const cell = Math.floor(Math.random() * MINES_TOTAL_CELLS);
      if (!bombCells.includes(cell)) bombCells.push(cell);
    }

    client = await pool.connect();
    await client.query('BEGIN');

    await tx(client, u.id, -numericBet, 'mines_bet', { mines: numericMines });

    const gameResult = await client.query(
      `
      INSERT INTO mine_games (user_id, bet, mines_count, bomb_cells)
      VALUES ($1, $2, $3, $4)
      RETURNING id
      `,
      [u.id, numericBet, numericMines, bombCells]
    );

    await client.query('COMMIT');

    const updated = await user(telegramId);
    return {
      gameId: gameResult.rows[0].id,
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

// Открыть клетку
app.post('/api/games/mines/:id/open', async (req: any, reply) => {
  try {
    const telegramId = auth(req);
    const u = await user(telegramId);
    const gameId = Number(req.params.id);
    const cell = Number(req.body?.cell);

    if (Number.isNaN(cell) || cell < 0 || cell > 24) {
      return reply.code(400).send({ error: 'Некорректная клетка' });
    }

    const gameResult = await pool.query(
      `
      SELECT *
      FROM mine_games
      WHERE id = $1
      AND user_id = $2
      `,
      [gameId, u.id]
    );
    const game = gameResult.rows[0];

    if (!game) {
      return reply.code(404).send({ error: 'Игра не найдена' });
    }
    if (game.status !== 'active') {
      return reply.code(400).send({ error: 'Игра уже завершена' });
    }
    if (game.opened_cells.includes(cell)) {
      return reply.code(400).send({ error: 'Клетка уже открыта' });
    }

    if (game.bomb_cells.includes(cell)) {
      await pool.query(
        `UPDATE mine_games SET status = 'lost' WHERE id = $1`,
        [gameId]
      );
      const updated = await user(telegramId);
      return { lost: true, balance: Number(updated.balance) };
    }

    const openedCells = [...game.opened_cells, cell];
    await pool.query(
      `UPDATE mine_games SET opened_cells = $1 WHERE id = $2`,
      [openedCells, gameId]
    );

    const multiplier = minesMultiplier(game.mines_count, openedCells.length);
    const updated = await user(telegramId);
    return {
      state: { multiplier },
      balance: Number(updated.balance),
    };
  } catch (error: any) {
    return reply.code(error.statusCode || 500).send({
      error: error.message || 'Ошибка',
    });
  }
});

// Забрать выигрыш
app.post('/api/games/mines/:id/cashout', async (req: any, reply) => {
  let client: any = null;
  try {
    const telegramId = auth(req);
    const u = await user(telegramId);
    const gameId = Number(req.params.id);

    client = await pool.connect();
    await client.query('BEGIN');

    const gameResult = await client.query(
      `
      SELECT *
      FROM mine_games
      WHERE id = $1
      AND user_id = $2
      FOR UPDATE
      `,
      [gameId, u.id]
    );
    const game = gameResult.rows[0];

    if (!game) {
      await client.query('ROLLBACK');
      return reply.code(404).send({ error: 'Игра не найдена' });
    }
    if (game.status !== 'active') {
      await client.query('ROLLBACK');
      return reply.code(400).send({ error: 'Игра уже завершена' });
    }

    const openedCount = game.opened_cells.length;
    const multiplier = openedCount > 0
      ? minesMultiplier(game.mines_count, openedCount)
      : 1;
    const payout = Math.floor(Number(game.bet) * multiplier);

    await client.query(
      `UPDATE mine_games SET status = 'cashed' WHERE id = $1`,
      [gameId]
    );

    await tx(client, u.id, payout, 'mines_win', { gameId, multiplier });

    await client.query('COMMIT');

    const updated = await user(telegramId);
    return {
      win: payout,
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

// ===== Игра "Краш" =====

// Сделать ставку и начать раунд
app.post('/api/games/crash/bet', async (req: any, reply) => {
  let client: any = null;
  try {
    const telegramId = auth(req);
    const u = await user(telegramId);
    const numericBet = Number(req.body?.bet);

    if (!numericBet || numericBet < 1) {
      return reply.code(400).send({ error: 'Некорректная ставка' });
    }
    if (Number(u.balance) < numericBet) {
      return reply.code(400).send({ error: 'Недостаточно листиков' });
    }

    const activeResult = await pool.query(
      `SELECT * FROM crash_rounds WHERE user_id = $1 AND status = 'active'`,
      [u.id]
    );
    const activeRound = activeResult.rows[0];

    if (activeRound) {
      const currentMultiplier = crashCurrentMultiplier(
        new Date(activeRound.started_at),
        Number(activeRound.crash_at)
      );
      if (currentMultiplier < Number(activeRound.crash_at)) {
        return reply.code(400).send({ error: 'У вас уже есть активный раунд' });
      }
      await pool.query(
        `UPDATE crash_rounds SET status = 'crashed' WHERE id = $1`,
        [activeRound.id]
      );
    }

    const crashAt = generateCrashPoint();

    client = await pool.connect();
    await client.query('BEGIN');

    await tx(client, u.id, -numericBet, 'crash_bet');

    const roundResult = await client.query(
      `
      INSERT INTO crash_rounds (user_id, bet, crash_at)
      VALUES ($1, $2, $3)
      RETURNING id
      `,
      [u.id, numericBet, crashAt]
    );

    await client.query('COMMIT');

    const updated = await user(telegramId);
    return {
      roundId: roundResult.rows[0].id,
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

// Забрать выигрыш до краха
app.post('/api/games/crash/cashout', async (req: any, reply) => {
  let client: any = null;
  try {
    const telegramId = auth(req);
    const u = await user(telegramId);

    client = await pool.connect();
    await client.query('BEGIN');

    const roundResult = await client.query(
      `
      SELECT *
      FROM crash_rounds
      WHERE user_id = $1
      AND status = 'active'
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
      `,
      [u.id]
    );
    const round = roundResult.rows[0];

    if (!round) {
      await client.query('ROLLBACK');
      return reply.code(400).send({ error: 'Нет активного раунда' });
    }

    const crashAt = Number(round.crash_at);
    const multiplier = crashCurrentMultiplier(new Date(round.started_at), crashAt);

    if (multiplier >= crashAt) {
      await client.query(
        `UPDATE crash_rounds SET status = 'crashed' WHERE id = $1`,
        [round.id]
      );
      await client.query('COMMIT');
      return reply.code(400).send({ error: 'Раунд уже завершился крахом' });
    }

    const payout = Math.floor(Number(round.bet) * multiplier);

    await client.query(
      `UPDATE crash_rounds SET status = 'cashed', cashout_multiplier = $1 WHERE id = $2`,
      [multiplier, round.id]
    );

    await tx(client, u.id, payout, 'crash_win', { roundId: round.id, multiplier });

    await client.query('COMMIT');

    const updated = await user(telegramId);
    return {
      win: payout,
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

// Webhook Telegram для подтверждения платежей
app.post('/telegram/webhook', async (req: any, reply) => {
  try {
    const update = req.body || {};

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
      update.message?.successful_payment ||
      update.successful_payment;

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

        await tx(
          client,
          u.id,
          Number(lockedOrder.leaves),
          'stars_purchase',
          {
            stars: Number(lockedOrder.stars),
            leaves: Number(lockedOrder.leaves),
            paymentId: payment.telegram_payment_charge_id,
          }
        );

        await client.query(
          `
          UPDATE payment_orders
          SET
            status = 'paid',
            telegram_payment_charge_id = $1,
            paid_at = NOW()
          WHERE id = $2
          `,
          [
            payment.telegram_payment_charge_id,
            lockedOrder.id,
          ]
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

  const result = await pool.query(
    'SELECT * FROM tasks ORDER BY id DESC'
  );
  return result.rows;
});

// Админ: создание задания
app.post('/api/admin/tasks', async (req: any, reply) => {
  if (req.headers['x-admin-key'] !== adminKey) {
    return reply.code(401).send({
      error: 'Нет доступа',
    });
  }

  const {
    title,
    description = '',
    channelUrl = '',
    reward = 10000,
  } = req.body || {};

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
    [
      title,
      description,
      channelUrl,
      Number(reward),
    ]
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
