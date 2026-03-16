const pool = require('../config/db');

// ── GET LATEST SIGNALS ─────────────────────
exports.getSignals = async (req, res) => {
  try {
    const { pair, limit = 20 } = req.query;

    // Free plan: USDJPY only
    if (req.user.plan === 'free' && pair && pair !== 'USD/JPY') {
      return res.status(403).json({
        success: false,
        message: 'Free plan only supports USD/JPY. Upgrade to Pro for all pairs.',
        upgrade: true
      });
    }

    let query = `SELECT * FROM signals`;
    let values = [];
    let idx = 1;

    if (pair) {
      query += ` WHERE pair = $${idx++}`;
      values.push(pair.toUpperCase());
    } else if (req.user.plan === 'free') {
      query += ` WHERE pair = 'USD/JPY'`;
    }

    query += ` ORDER BY created_at DESC LIMIT $${idx}`;
    values.push(parseInt(limit));

    const signals = await pool.query(query, values);
    res.json({ success: true, signals: signals.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── SAVE A SIGNAL (internal use) ───────────
exports.saveSignal = async (req, res) => {
  try {
    const {
      pair, direction, entry_price,
      stop_loss, tp1, tp2, tp3,
      confluence_score, htf_bias, session, atr
    } = req.body;

    const signal = await pool.query(
      `INSERT INTO signals
        (pair, direction, entry_price, stop_loss, tp1, tp2, tp3,
         confluence_score, htf_bias, session, atr)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [pair, direction, entry_price, stop_loss, tp1, tp2, tp3,
       confluence_score, htf_bias, session, atr]
    );

    res.status(201).json({ success: true, signal: signal.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};
