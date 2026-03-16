const express = require('express');
const router  = express.Router();
const { protect, requirePro } = require('../middleware/auth');

const authCtrl    = require('../controllers/authController');
const tradeCtrl   = require('../controllers/tradeController');
const payCtrl     = require('../controllers/paymentController');
const signalCtrl  = require('../controllers/signalController');

// ─── AUTH ──────────────────────────────────
router.post('/auth/register',     authCtrl.register);
router.post('/auth/login',        authCtrl.login);
router.post('/auth/google',       authCtrl.googleAuth);
router.get ('/auth/me',           protect, authCtrl.getProfile);
router.put ('/auth/me',           protect, authCtrl.updateProfile);

// ─── TRADES ────────────────────────────────
router.get ('/trades',            protect, tradeCtrl.getTrades);
router.post('/trades',            protect, tradeCtrl.createTrade);
router.put ('/trades/:id',        protect, tradeCtrl.updateTrade);
router.delete('/trades/:id',      protect, tradeCtrl.deleteTrade);
router.get ('/trades/stats',      protect, tradeCtrl.getStats);

// ─── SIGNALS ───────────────────────────────
router.get ('/signals',           protect, signalCtrl.getSignals);
router.post('/signals',           protect, signalCtrl.saveSignal);

// ─── PAYMENTS ──────────────────────────────
// M-Pesa
router.post('/payments/mpesa',              protect, payCtrl.mpesaPay);
router.post('/payments/mpesa/callback',              payCtrl.mpesaCallback);
router.get ('/payments/mpesa/status/:checkoutRequestId', protect, payCtrl.mpesaStatus);

// Airtel Money
router.post('/payments/airtel',             protect, payCtrl.airtelPay);
router.post('/payments/airtel/callback',             payCtrl.airtelCallback);

// Binance Pay
router.post('/payments/binance',            protect, payCtrl.binancePay);
router.post('/payments/binance/callback',            payCtrl.binanceCallback);

// OKX Pay
router.post('/payments/okx',               protect, payCtrl.okxPay);
router.post('/payments/okx/callback',               payCtrl.okxCallback);

// General
router.get ('/payments/status',            protect, payCtrl.getSubscription);

module.exports = router;
