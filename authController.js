const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

// Generate JWT
const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
};

// Send token response
const sendToken = (user, statusCode, res) => {
  const token = signToken(user.id);
  res.status(statusCode).json({
    success: true,
    token,
    user: {
      id:         user.id,
      name:       user.name,
      email:      user.email,
      plan:       user.plan,
      created_at: user.created_at
    }
  });
};

// ── REGISTER ──────────────────────────────
exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide name, email and password.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    // Check if email already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      return res.status(409).json({ success: false, message: 'Email already registered. Please log in.' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    const result = await pool.query(
      `INSERT INTO users (name, email, password, plan)
       VALUES ($1, $2, $3, 'free')
       RETURNING id, name, email, plan, created_at`,
      [name.trim(), email.toLowerCase(), hashedPassword]
    );

    sendToken(result.rows[0], 201, res);
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ── LOGIN ─────────────────────────────────
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password.' });
    }

    // Get user with password
    const result = await pool.query(
      'SELECT id, name, email, password, plan, created_at FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (!result.rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const user = result.rows[0];

    // Check password
    if (!user.password) {
      return res.status(401).json({ success: false, message: 'This account uses Google login. Please sign in with Google.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    sendToken(user, 200, res);
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ── GOOGLE OAUTH ──────────────────────────
exports.googleAuth = async (req, res) => {
  try {
    const { googleId, email, name } = req.body;

    if (!googleId || !email) {
      return res.status(400).json({ success: false, message: 'Missing Google credentials.' });
    }

    // Check if user exists
    let result = await pool.query(
      'SELECT id, name, email, plan, created_at FROM users WHERE google_id = $1 OR email = $2',
      [googleId, email.toLowerCase()]
    );

    if (result.rows.length) {
      // Update google_id if needed
      await pool.query('UPDATE users SET google_id = $1 WHERE email = $2', [googleId, email.toLowerCase()]);
      sendToken(result.rows[0], 200, res);
    } else {
      // Create new user
      result = await pool.query(
        `INSERT INTO users (name, email, google_id, plan)
         VALUES ($1, $2, $3, 'free')
         RETURNING id, name, email, plan, created_at`,
        [name, email.toLowerCase(), googleId]
      );
      sendToken(result.rows[0], 201, res);
    }
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── GET PROFILE ───────────────────────────
exports.getProfile = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, plan, created_at,
              subscription_end_date
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── UPDATE PROFILE ────────────────────────
exports.updateProfile = async (req, res) => {
  try {
    const { name, currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    let updateFields = [];
    let values = [];
    let idx = 1;

    if (name) {
      updateFields.push(`name = $${idx++}`);
      values.push(name.trim());
    }

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ success: false, message: 'Please provide current password.' });
      }
      const user = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
      const isMatch = await bcrypt.compare(currentPassword, user.rows[0].password);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
      }
      const hashed = await bcrypt.hash(newPassword, 12);
      updateFields.push(`password = $${idx++}`);
      values.push(hashed);
    }

    if (!updateFields.length) {
      return res.status(400).json({ success: false, message: 'Nothing to update.' });
    }

    updateFields.push(`updated_at = NOW()`);
    values.push(userId);

    await pool.query(
      `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${idx}`,
      values
    );

    res.json({ success: true, message: 'Profile updated.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};
