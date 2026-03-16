const jwt = require('jsonwebtoken');
const pool = require('../config/db');

// Verify JWT token
const protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({ success: false, message: 'Not authorized. Please log in.' });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Get user from DB
    const result = await pool.query(
      'SELECT id, name, email, plan, created_at FROM users WHERE id = $1',
      [decoded.id]
    );

    if (!result.rows.length) {
      return res.status(401).json({ success: false, message: 'User no longer exists.' });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, message: 'Invalid token.' });
    }
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired. Please log in again.' });
    }
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// Require Pro or Lifetime plan
const requirePro = (req, res, next) => {
  if (req.user.plan === 'free') {
    return res.status(403).json({
      success: false,
      message: 'This feature requires a Pro or Lifetime plan.',
      upgrade: true
    });
  }
  next();
};

// Require Lifetime plan
const requireLifetime = (req, res, next) => {
  if (req.user.plan !== 'lifetime') {
    return res.status(403).json({
      success: false,
      message: 'This feature requires a Lifetime plan.',
      upgrade: true
    });
  }
  next();
};

module.exports = { protect, requirePro, requireLifetime };
