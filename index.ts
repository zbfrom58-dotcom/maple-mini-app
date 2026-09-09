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

const adminKey = process.env.ADMIN_KEY || 'change_me';

app.register(fastifyStatic, {
  root: path.join(process.cwd(), 'public'),
});

app.get('/', async (_, reply) => {
  return reply.sendFile('index.html');
});

// Получаем Telegram ID пользователя
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

// Получаем или создаём пользователя.
// ON CONFLICT предотвращает ошибку duplicate key.
async function user(tg: string) {
  const result = await pool.query(
    `
    INSERT INTO users (telegram_id, balance)
    VALUES ($1, 0)
    ON CONFLICT (telegram_id)
    DO UPDATE SET telegram_id = EXCLUDED.telegram_id
    RETURNING *
    `,
    [tg]
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

    const alreadyCompleted = await client.query(
      `
      SELECT 1
      FROM task_completions
      WHERE user_id = $1
        AND task_id = $2
      `,
      [u.id, task.id]
    );

    if (alreadyCompleted.rows.length > 0) {
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

// Создание игры
app.post('/api/games/mines', async (req: any, reply) => {
  let client: any = null;

  try {
    const telegramId = auth(req);
    const { bet = 50, mines = 3 } = req.body || {};
    const numericBet = Number(bet);
    const numericMines = Number(mines);

    const u = await user(telegramId);

    if (
      ![50, 500, 1000, 5000].includes(numericBet) ||
      !Number.isInteger(numericMines) ||
      numericMines < 1 ||
      numericMines > 12
    ) {
      return reply.code(400).send({
        error: 'Неверные параметры',
      });
    }

    if (Number(u.balance) < numericBet) {
      return reply.code(400).send({
        error: 'Недостаточно листиков',
      });
    }

    const bombs = [...Array(36).keys()]
      .sort(() => Math.random() - 0.5)
      .slice(0, numericMines);

    client = await pool.connect();

    await client.query('BEGIN');

    await tx(client, u.id, -numericBet, 'mine_bet', {
      bet: numericBet,
      mines: numericMines,
    });

    const gameResult = await client.query(
      `
      INSERT INTO games (user_id, bet, mines, state, status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
      `,
      [
        u.id,
        numericBet,
        numericMines,
        JSON.stringify({
          bombs,
          opened: [],
          multiplier: 1,
        }),
        'active',
      ]
    );

    await client.query('COMMIT');

    const updated = await user(telegramId);

    return {
      gameId: gameResult.rows[0].id,
      bombs: [],
      balance: Number(updated.balance),
    };
  } catch (error: any) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }

    return reply.code(error.statusCode || 500).send({
      error: error.message || 'Ошибка игры',
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Открытие клетки
app.post('/api/games/mines/:id/open', async (req: any, reply) => {
  let client: any = null;

  try {
    const telegramId = auth(req);
    const u = await user(telegramId);

    client = await pool.connect();

    const gameResult = await client.query(
      `
      SELECT *
      FROM games
      WHERE id = $1
        AND user_id = $2
        AND status = 'active'
      `,
      [req.params.id, u.id]
    );

    const game = gameResult.rows[0];

    if (!game) {
      return reply.code(404).send({
        error: 'Игра не найдена',
      });
    }

    const cell = Number(req.body?.cell);
    const state =
      typeof game.state === 'string'
        ? JSON.parse(game.state)
        : game.state;

    if (
      !Number.isInteger(cell) ||
      cell < 0 ||
      cell > 35
    ) {
      return reply.code(400).send({
        error: 'Неверная клетка',
      });
    }

    if (state.opened.includes(cell)) {
      return {
        balance: Number(u.balance),
        state,
      };
    }

    if (state.bombs.includes(cell)) {
      state.opened.push(cell);

      await client.query(
        `
        UPDATE games
        SET state = $1,
            status = 'lost'
        WHERE id = $2
        `,
        [JSON.stringify(state), game.id]
      );

      return {
        lost: true,
        balance: Number(u.balance),
        state,
      };
    }

    state.opened.push(cell);
    state.multiplier = 1 + state.opened.length * 0.15;

    const reward = Math.floor(
      Number(game.bet) * state.multiplier
    );

    await client.query('BEGIN');

    await tx(client, u.id, reward, 'mine_win', {
      gameId: game.id,
      cell,
    });

    await client.query(
      `
      UPDATE games
      SET state = $1
      WHERE id = $2
      `,
      [JSON.stringify(state), game.id]
    );

    await client.query('COMMIT');

    const updated = await user(telegramId);

    return {
      reward,
      balance: Number(updated.balance),
      state,
    };
  } catch (error: any) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }

    return reply.code(error.statusCode || 500).send({
      error: error.message || 'Ошибка игры',
    });
  } finally {
    if (client) {
      client.release();
    }
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

// Запуск сервера
app.listen({
  port: Number(process.env.PORT || 3000),
  host: '0.0.0.0',
});
