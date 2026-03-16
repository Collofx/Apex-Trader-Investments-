const pool = require('../config/db');

// ── GET ALL TRADES ─────────────────────────
exports.getTrades = async (req, res) => {
  try {
    const { pair, result, limit = 50, offset = 0 } = req.query;

    let query = `SELECT * FROM trades WHERE user_id = $1`;
    let values = [req.user.id];
    let idx = 2;

    if (pair) {
      query += ` AND pair = $${idx++}`;
      values.push(pair.toUpperCase());
    }
    if (result) {
      query += ` AND result = $${idx++}`;
      values.push(result);
    }

    query += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    values.push(parseInt(limit), parseInt(offset));

    const trades = await pool.query(query, values);

    // Get total count
    const countRes = await pool.query(
      'SELECT COUNT(*) FROM trades WHERE user_id = $1',
      [req.user.id]
    );

    res.json({
      success: true,
      count: parseInt(countRes.rows[0].count),
      trades: trades.rows
    });
  } catch (err) {
    console.error('Get trades error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── LOG A TRADE ────────────────────────────
exports.createTrade = async (req, res) => {
  try {
    const {
      pair, direction, entry_price, exit_price,
      stop_loss, take_profit, lot_size,
      session, timeframe, confluences, notes
    } = req.body;

    if (!pair || !direction || !entry_price) {
      return res.status(400).json({ success: false, message: 'Pair, direction and entry price are required.' });
    }

    // Calculate pips and result
    let pips = null, result = 'open', profit_usd = null;
    const pipSize = pair.includes('JPY') || pair.includes('XAU')
      ? (pair.includes('XAU') ? 0.1 : 0.01) : 0.0001;

    if (exit_price) {
      pips = direction === 'BUY'
        ? (parseFloat(exit_price) - parseFloat(entry_price)) / pipSize
        : (parseFloat(entry_price) - parseFloat(exit_price)) / pipSize;

      result = pips > 0 ? 'win' : pips < 0 ? 'loss' : 'breakeven';
      profit_usd = pips * (parseFloat(lot_size) || 0.01) * 0.9; // approx
    }

    const trade = await pool.query(
      `INSERT INTO trades
        (user_id, pair, direction, entry_price, exit_price, stop_loss,
         take_profit, lot_size, pips, profit_usd, result, session,
         timeframe, confluences, notes, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        req.user.id, pair.toUpperCase(), direction.toUpperCase(),
        entry_price, exit_price || null, stop_loss || null,
        take_profit || null, lot_size || 0.01,
        pips ? pips.toFixed(1) : null,
        profit_usd ? profit_usd.toFixed(2) : null,
        result, session || null, timeframe || 'H1',
        confluences || [],
        notes || null,
        exit_price ? new Date() : null
      ]
    );

    res.status(201).json({ success: true, trade: trade.rows[0] });
  } catch (err) {
    console.error('Create trade error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── UPDATE TRADE (close it) ────────────────
exports.updateTrade = async (req, res) => {
  try {
    const { id } = req.params;
    const { exit_price, notes } = req.body;

    // Verify ownership
    const existing = await pool.query(
      'SELECT * FROM trades WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ success: false, message: 'Trade not found.' });
    }

    const trade = existing.rows[0];
    const pipSize = trade.pair.includes('JPY') ? 0.01 : 0.0001;
    const pips = trade.direction === 'BUY'
      ? (parseFloat(exit_price) - parseFloat(trade.entry_price)) / pipSize
      : (parseFloat(trade.entry_price) - parseFloat(exit_price)) / pipSize;
    const result = pips > 0 ? 'win' : pips < 0 ? 'loss' : 'breakeven';

    const updated = await pool.query(
      `UPDATE trades SET
        exit_price = $1, pips = $2, result = $3,
        notes = COALESCE($4, notes),
        closed_at = NOW()
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [exit_price, pips.toFixed(1), result, notes, id, req.user.id]
    );

    res.json({ success: true, trade: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── DELETE TRADE ───────────────────────────
exports.deleteTrade = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM trades WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Trade not found.' });
    }
    res.json({ success: true, message: 'Trade deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── GET STATS ──────────────────────────────
exports.getStats = async (req, res) => {
  try {
    const userId = req.user.id;

    const stats = await pool.query(`
      SELECT
        COUNT(*)                                          AS total_trades,
        COUNT(*) FILTER (WHERE result = 'win')            AS wins,
        COUNT(*) FILTER (WHERE result = 'loss')           AS losses,
        ROUND(
          COUNT(*) FILTER (WHERE result = 'win')::DECIMAL
          / NULLIF(COUNT(*) FILTER (WHERE result IN ('win','loss')), 0) * 100, 1
        )                                                 AS win_rate,
        ROUND(COALESCE(SUM(pips), 0), 1)                 AS total_pips,
        ROUND(COALESCE(SUM(profit_usd), 0), 2)           AS total_profit,
        ROUND(COALESCE(AVG(pips) FILTER (WHERE result='win'), 0), 1)  AS avg_win_pips,
        ROUND(COALESCE(AVG(pips) FILTER (WHERE result='loss'), 0), 1) AS avg_loss_pips,
        MAX(pips)                                         AS best_trade,
        MIN(pips)                                         AS worst_trade
      FROM trades
      WHERE user_id = $1 AND result != 'open'
    `, [userId]);

    // Best performing pair
    const byPair = await pool.query(`
      SELECT pair,
        COUNT(*) AS trades,
        COUNT(*) FILTER (WHERE result='win') AS wins,
        ROUND(SUM(pips)::DECIMAL, 1) AS total_pips
      FROM trades
      WHERE user_id = $1 AND result != 'open'
      GROUP BY pair
      ORDER BY total_pips DESC
    `, [userId]);

    // Monthly breakdown
    const monthly = await pool.query(`
      SELECT
        TO_CHAR(created_at, 'Mon YYYY') AS month,
        COUNT(*) AS trades,
        COUNT(*) FILTER (WHERE result='win') AS wins,
        ROUND(SUM(pips)::DECIMAL, 1) AS pips
      FROM trades
      WHERE user_id = $1 AND result != 'open'
      GROUP BY month, DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) DESC
      LIMIT 6
    `, [userId]);

    res.json({
      success: true,
      stats: stats.rows[0],
      by_pair: byPair.rows,
      monthly: monthly.rows
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};
