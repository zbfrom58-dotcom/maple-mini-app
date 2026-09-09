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

app.get('/', async (_, r) => r.sendFile('index.html'));

// Получаем настоящий Telegram ID.
// Общего demo-user больше нет.
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

async function user(tg: string) {
  let q = await pool.query(
    'SELECT * FROM users WHERE telegram_id=$1',
    [tg]
  );

  if (!q.rows[0]) {
    q = await pool.query(
      `INSERT INTO users(telegram_id, balance)
       VALUES($1, 0)
       RETURNING *`,
      [tg]
    );
  }

  return q.rows[0];
}

async function tx(
  client: any,
  id: number,
  amount: number,
  type: string,
  meta = {}
) {
  await client.query(
    'UPDATE users SET balance=balance+$1 WHERE id=$2',
    [amount, id]
  );

  await client.query(
    `INSERT INTO transactions(user_id, amount, type, meta)
     VALUES($1, $2, $3, $4)`,
    [id, amount, type, meta]
  );
}

app.get('/api/me', async (req: any, rep) => {
  try {
    const u = await user(auth(req));

    return {
      id: u.telegram_id,
      balance: u.balance,
      firstName: u.first_name || 'Игрок',
    };
  } catch (e: any) {
    return rep.code(e.statusCode || 500).send({
      error: e.message || 'Ошибка',
    });
  }
});

app.post('/api/daily', async (req: any, rep) => {
  const c = await pool.connect();

  try {
    const u = await user(auth(req));

    const ok =
      !u.last_daily_at ||
      Date.now() - new Date(u.last_daily_at).getTime() > 86400000;

    if (!ok) {
      return rep.code(400).send({
        error: 'Бонус уже получен',
      });
    }

    await c.query('BEGIN');

    await c.query(
      'UPDATE users SET last_daily_at=NOW() WHERE id=$1',
      [u.id]
    );

    await tx(c, u.id, 2500, 'daily');

    await c.query('COMMIT');

    const updated = await user(auth(req));

    return {
      balance: updated.balance,
      reward: 2500,
    };
  } catch (e: any) {
    await c.query('ROLLBACK');

    return rep.code(e.statusCode || 500).send({
      error: e.message || 'Ошибка',
    });
  } finally {
    c.release();
  }
});

app.get('/api/tasks', async (req: any, rep) => {
  try {
    const u = await user(auth(req));

    const q = await pool.query(
      `SELECT
         t.*,
         c.created_at AS completed_at
       FROM tasks t
       LEFT JOIN task_completions c
         ON c.task_id=t.id AND c.user_id=$1
       WHERE t.active=true
       ORDER BY t.id`,
      [u.id]
    );

    return q.rows;
  } catch (e: any) {
    return rep.code(e.statusCode || 500).send({
      error: e.message || 'Ошибка',
    });
  }
});

app.post('/api/tasks/:id/claim', async (req: any, rep) => {
  const c = await pool.connect();

  try {
    const u = await user(auth(req));

    const t = (
      await c.query(
        'SELECT * FROM tasks WHERE id=$1 AND active=true',
        [req.params.id]
      )
    ).rows[0];

    if (!t) {
      return rep.code(404).send({
        error: 'Задание не найдено',
      });
    }

    await c.query('BEGIN');

    await c.query(
      `INSERT INTO task_completions(user_id, task_id)
       VALUES($1, $2)`,
      [u.id, t.id]
    );

    await tx(c, u.id, t.reward, 'task', {
      taskId: t.id,
    });

    await c.query('COMMIT');

    const updated = await user(auth(req));

    return {
      balance: updated.balance,
    };
  } catch (e: any) {
    await c.query('ROLLBACK');

    return rep.code(400).send({
      error: 'Задание уже выполнено',
    });
  } finally {
    c.release();
  }
});

app.get('/api/shop', async () => ({
  packages: (
    await pool.query(
      `SELECT *
       FROM shop_packages
       WHERE active=true
       ORDER BY stars`
    )
  ).rows,
}));

app.post('/api/games/mines', async (req: any, rep) => {
  try {
    const { bet = 50, mines = 3 } = req.body || {};
    const u = await user(auth(req));

    if (
      ![50, 500, 1000, 5000].includes(Number(bet)) ||
      !Number.isInteger(mines) ||
      mines < 1 ||
      mines > 12
    ) {
      return rep.code(400).send({
        error: 'Неверные параметры',
      });
    }

    if (Number(u.balance) < Number(bet)) {
      return rep.code(400).send({
        error: 'Недостаточно листиков',
      });
    }

    const bombs = [...Array(36).keys()]
      .sort(() => Math.random() - 0.5)
      .slice(0, mines);

    const c = await pool.connect();

    try {
      await c.query('BEGIN');

      await tx(c, u.id, -Number(bet), 'mine_bet', {
        bet: Number(bet),
        mines,
      });

      const game = (
        await c.query(
          `INSERT INTO games(user_id, bet, mines, state, status)
           VALUES($1, $2, $3, $4, $5)
           RETURNING id`,
          [
            u.id,
            Number(bet),
            mines,
            {
              bombs,
              opened: [],
              multiplier: 1,
            },
            'active',
          ]
        )
      ).rows[0];

      await c.query('COMMIT');

      const updated = await user(auth(req));

      return {
        gameId: game.id,
        bombs: [],
        balance: updated.balance,
      };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  } catch (e: any) {
    return rep.code(e.statusCode || 500).send({
      error: e.message || 'Ошибка',
    });
  }
});

app.post('/api/games/mines/:id/open', async (req: any, rep) => {
  const c = await pool.connect();

  try {
    const u = await user(auth(req));

    const g = (
      await c.query(
        `SELECT *
         FROM games
         WHERE id=$1 AND user_id=$2 AND status=$3`,
        [req.params.id, u.id, 'active']
      )
    ).rows[0];

    if (!g) {
      return rep.code(404).send({
        error: 'Игра не найдена',
      });
    }

    const cell = Number(req.body?.cell);
    const s = g.state;

    if (s.opened.includes(cell)) {
      return {
        balance: u.balance,
        state: s,
      };
    }

    if (s.bombs.includes(cell)) {
      await c.query(
        'UPDATE games SET status=$1 WHERE id=$2',
        ['lost', g.id]
      );

      return {
        lost: true,
        balance: u.balance,
        state: {
          ...s,
          opened: [...s.opened, cell],
        },
      };
    }

    s.opened.push(cell);
    s.multiplier = 1 + s.opened.length * 0.15;

    const reward = Math.floor(g.bet * s.multiplier);

    await c.query('BEGIN');

    await tx(c, u.id, reward, 'mine_win', {
      gameId: g.id,
      cell,
    });

    await c.query(
      'UPDATE games SET state=$1 WHERE id=$2',
      [s, g.id]
    );

    await c.query('COMMIT');

    const updated = await user(auth(req));

    return {
      reward,
      balance: updated.balance,
      state: s,
    };
  } catch (e: any) {
    await c.query('ROLLBACK');

    return rep.code(e.statusCode || 500).send({
      error: e.message || 'Ошибка',
    });
  } finally {
    c.release();
  }
});

app.get('/api/admin/tasks', async (req: any, rep) => {
  if (req.headers['x-admin-key'] !== adminKey) {
    return rep.code(401).send({
      error: 'Нет доступа',
    });
  }

  return (
    await pool.query('SELECT * FROM tasks ORDER BY id DESC')
  ).rows;
});

app.post('/api/admin/tasks', async (req: any, rep) => {
  if (req.headers['x-admin-key'] !== adminKey) {
    return rep.code(401).send({
      error: 'Нет доступа',
    });
  }

  const {
    title,
    description = '',
    channelUrl = '',
    reward = 10000,
  } = req.body || {};

  return (
    await pool.query(
      `INSERT INTO tasks(title, description, channel_url, reward)
       VALUES($1, $2, $3, $4)
       RETURNING *`,
      [title, description, channelUrl, reward]
    )
  ).rows[0];
});

app.get('/health', async () => ({
  ok: true,
}));

app.listen({
  port: Number(process.env.PORT || 3000),
  host: '0.0.0.0',
});
