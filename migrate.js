require('dotenv').config();
const pool = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');

    await client.query(`
      -- USERS TABLE
      CREATE TABLE IF NOT EXISTS users (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name        VARCHAR(100) NOT NULL,
        email       VARCHAR(255) UNIQUE NOT NULL,
        password    VARCHAR(255),
        google_id   VARCHAR(255),
        plan        VARCHAR(20) DEFAULT 'free' CHECK (plan IN ('free','pro','lifetime')),
        stripe_customer_id  VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        subscription_end_date TIMESTAMPTZ,
        api_key     VARCHAR(255),
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- TRADES TABLE (Journal)
      CREATE TABLE IF NOT EXISTS trades (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pair        VARCHAR(20) NOT NULL,
        direction   VARCHAR(4) NOT NULL CHECK (direction IN ('BUY','SELL')),
        entry_price DECIMAL(12,5) NOT NULL,
        exit_price  DECIMAL(12,5),
        stop_loss   DECIMAL(12,5),
        take_profit DECIMAL(12,5),
        lot_size    DECIMAL(8,2) DEFAULT 0.01,
        pips        DECIMAL(8,1),
        profit_usd  DECIMAL(10,2),
        result      VARCHAR(10) CHECK (result IN ('win','loss','breakeven','open')),
        session     VARCHAR(20),
        timeframe   VARCHAR(10),
        confluences TEXT[],
        notes       TEXT,
        screenshot_url VARCHAR(500),
        opened_at   TIMESTAMPTZ DEFAULT NOW(),
        closed_at   TIMESTAMPTZ,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- SIGNALS TABLE (history of all signals generated)
      CREATE TABLE IF NOT EXISTS signals (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pair        VARCHAR(20) NOT NULL,
        direction   VARCHAR(4) NOT NULL,
        entry_price DECIMAL(12,5),
        stop_loss   DECIMAL(12,5),
        tp1         DECIMAL(12,5),
        tp2         DECIMAL(12,5),
        tp3         DECIMAL(12,5),
        confluence_score INTEGER,
        htf_bias    VARCHAR(10),
        session     VARCHAR(20),
        timeframe   VARCHAR(10),
        atr         DECIMAL(12,5),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- SUBSCRIPTIONS TABLE
      CREATE TABLE IF NOT EXISTS subscriptions (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan               VARCHAR(20) NOT NULL,
        status             VARCHAR(20) DEFAULT 'active',
        amount_paid        DECIMAL(10,2),
        payment_method     VARCHAR(20) CHECK (payment_method IN ('mpesa','airtel','binance','okx','manual')),
        payment_reference  VARCHAR(255),
        currency           VARCHAR(10) DEFAULT 'USD',
        started_at         TIMESTAMPTZ DEFAULT NOW(),
        ends_at            TIMESTAMPTZ,
        created_at         TIMESTAMPTZ DEFAULT NOW()
      );

      -- PENDING PAYMENTS TABLE (awaiting confirmation)
      CREATE TABLE IF NOT EXISTS pending_payments (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan                 VARCHAR(20) NOT NULL,
        method               VARCHAR(20) NOT NULL,
        checkout_request_id  VARCHAR(255) UNIQUE,
        created_at           TIMESTAMPTZ DEFAULT NOW(),
        expires_at           TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 minutes'
      );

      -- WATCHLIST TABLE
      CREATE TABLE IF NOT EXISTS watchlist (
        id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pair    VARCHAR(20) NOT NULL,
        notes   TEXT,
        added_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, pair)
      );

      -- Create indexes for performance
      CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id);
      CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades(pair);
      CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_signals_pair ON signals(pair);
      CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `);

    console.log('✅ All tables created successfully!');
  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
