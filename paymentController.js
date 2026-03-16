require('dotenv').config();
const axios  = require('axios');
const crypto = require('crypto');
const pool   = require('../config/db');

// ═══════════════════════════════════════════════════════════
//  PLAN PRICING
// ═══════════════════════════════════════════════════════════
const PLANS = {
  pro:      { amount_usd: 29,  amount_kes: 3800,  name: 'Apex Trader Pro (Monthly)'  },
  lifetime: { amount_usd: 149, amount_kes: 19500, name: 'Apex Trader Lifetime'        },
};

// ═══════════════════════════════════════════════════════════
//  HELPER — activate user plan after confirmed payment
// ═══════════════════════════════════════════════════════════
async function activatePlan(userId, plan, paymentRef, method, amountPaid) {
  const endsAt = plan === 'pro'
    ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    : null;

  await pool.query(
    `UPDATE users SET plan = $1, subscription_end_date = $2, updated_at = NOW() WHERE id = $3`,
    [plan, endsAt, userId]
  );

  await pool.query(
    `INSERT INTO subscriptions
       (user_id, plan, status, amount_paid, payment_method, payment_reference, started_at, ends_at)
     VALUES ($1,$2,'active',$3,$4,$5,NOW(),$6)`,
    [userId, plan, amountPaid, method, paymentRef, endsAt]
  );
}

// ═══════════════════════════════════════════════════════════
//  1. M-PESA (Safaricom Daraja — STK Push)
// ═══════════════════════════════════════════════════════════
async function getMpesaToken() {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');
  const res = await axios.get(
    'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return res.data.access_token;
}

exports.mpesaPay = async (req, res) => {
  try {
    const { plan, phone } = req.body;
    const userId = req.user.id;

    if (!PLANS[plan]) return res.status(400).json({ success: false, message: 'Invalid plan.' });
    if (!phone)       return res.status(400).json({ success: false, message: 'Phone number required. e.g. 0712345678' });

    let tel = phone.replace(/\s+/g, '');
    if (tel.startsWith('0'))  tel = '254' + tel.slice(1);
    if (tel.startsWith('+'))  tel = tel.slice(1);

    const token     = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
    const password  = Buffer.from(
      process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp
    ).toString('base64');

    const stkRes = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password:          password,
        Timestamp:         timestamp,
        TransactionType:   'CustomerPayBillOnline',
        Amount:            PLANS[plan].amount_kes,
        PartyA:            tel,
        PartyB:            process.env.MPESA_SHORTCODE,
        PhoneNumber:       tel,
        CallBackURL:       `${process.env.BACKEND_URL}/api/payments/mpesa/callback`,
        AccountReference:  `APEX-${userId.slice(0,8).toUpperCase()}`,
        TransactionDesc:   PLANS[plan].name,
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    await pool.query(
      `INSERT INTO pending_payments (user_id, plan, method, checkout_request_id, created_at)
       VALUES ($1,$2,'mpesa',$3,NOW()) ON CONFLICT DO NOTHING`,
      [userId, plan, stkRes.data.CheckoutRequestID]
    );

    res.json({
      success:           true,
      message:           `STK push sent to ${tel}. Enter your M-Pesa PIN to pay KES ${PLANS[plan].amount_kes}.`,
      checkoutRequestId: stkRes.data.CheckoutRequestID
    });
  } catch (err) {
    console.error('M-Pesa error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'M-Pesa request failed. Check your phone number and try again.' });
  }
};

exports.mpesaCallback = async (req, res) => {
  try {
    const cb    = req.body.Body?.stkCallback;
    const reqId = cb?.CheckoutRequestID;
    if (cb?.ResultCode === 0) {
      const meta     = cb.CallbackMetadata?.Item || [];
      const amount   = meta.find(i => i.Name === 'Amount')?.Value;
      const mpesaRef = meta.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
      const pending  = await pool.query(
        'SELECT user_id, plan FROM pending_payments WHERE checkout_request_id = $1', [reqId]
      );
      if (pending.rows.length) {
        await activatePlan(pending.rows[0].user_id, pending.rows[0].plan, mpesaRef, 'mpesa', amount);
        await pool.query('DELETE FROM pending_payments WHERE checkout_request_id = $1', [reqId]);
      }
    }
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (err) {
    res.json({ ResultCode: 0, ResultDesc: 'Acknowledged' });
  }
};

exports.mpesaStatus = async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;
    const pending = await pool.query(
      'SELECT * FROM pending_payments WHERE checkout_request_id = $1', [checkoutRequestId]
    );
    if (!pending.rows.length) {
      const user = await pool.query('SELECT plan FROM users WHERE id = $1', [req.user.id]);
      return res.json({ success: true, status: 'completed', plan: user.rows[0].plan });
    }
    res.json({ success: true, status: 'pending' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Status check failed.' });
  }
};

// ═══════════════════════════════════════════════════════════
//  2. AIRTEL MONEY (Airtel Africa API)
// ═══════════════════════════════════════════════════════════
async function getAirtelToken() {
  const res = await axios.post(
    'https://openapi.airtel.africa/auth/oauth2/token',
    { client_id: process.env.AIRTEL_CLIENT_ID, client_secret: process.env.AIRTEL_CLIENT_SECRET, grant_type: 'client_credentials' },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return res.data.access_token;
}

exports.airtelPay = async (req, res) => {
  try {
    const { plan, phone, country = 'KE' } = req.body;
    const userId    = req.user.id;
    const currency  = country === 'UG' ? 'UGX' : country === 'TZ' ? 'TZS' : 'KES';

    if (!PLANS[plan]) return res.status(400).json({ success: false, message: 'Invalid plan.' });
    if (!phone)       return res.status(400).json({ success: false, message: 'Phone number required.' });

    const token     = await getAirtelToken();
    const reference = `APEX${Date.now()}`;

    const airtelRes = await axios.post(
      'https://openapi.airtel.africa/merchant/v1/payments/',
      {
        reference,
        subscriber: { country, currency, msisdn: phone.replace(/^\+?0?/, '') },
        transaction: { amount: PLANS[plan].amount_kes, country, currency, id: reference }
      },
      {
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Country':    country,
          'X-Currency':   currency,
        }
      }
    );

    const txId = airtelRes.data?.data?.transaction?.id || reference;
    await pool.query(
      `INSERT INTO pending_payments (user_id, plan, method, checkout_request_id, created_at)
       VALUES ($1,$2,'airtel',$3,NOW())`,
      [userId, plan, txId]
    );

    res.json({
      success:       true,
      transactionId: txId,
      message:       `Airtel Money request sent to ${phone}. Approve the prompt on your phone.`
    });
  } catch (err) {
    console.error('Airtel error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Airtel Money request failed. Try again.' });
  }
};

exports.airtelCallback = async (req, res) => {
  try {
    const { transaction } = req.body;
    if (transaction?.status === 'TS') {
      const pending = await pool.query(
        'SELECT user_id, plan FROM pending_payments WHERE checkout_request_id = $1',
        [transaction.id]
      );
      if (pending.rows.length) {
        await activatePlan(pending.rows[0].user_id, pending.rows[0].plan,
          transaction.airtel_money_id, 'airtel', transaction.amount);
        await pool.query('DELETE FROM pending_payments WHERE checkout_request_id = $1', [transaction.id]);
      }
    }
    res.json({ status: 'SUCCESS' });
  } catch (err) {
    res.json({ status: 'SUCCESS' });
  }
};

// ═══════════════════════════════════════════════════════════
//  3. BINANCE PAY
// ═══════════════════════════════════════════════════════════
exports.binancePay = async (req, res) => {
  try {
    const { plan } = req.body;
    const userId   = req.user.id;

    if (!PLANS[plan]) return res.status(400).json({ success: false, message: 'Invalid plan.' });

    const timestamp       = Date.now().toString();
    const nonce           = crypto.randomBytes(16).toString('hex').toUpperCase();
    const merchantTradeNo = `APEX${timestamp}${userId.slice(0,6).toUpperCase()}`;

    const payload = {
      env:              { terminalType: 'WEB' },
      merchantTradeNo,
      orderAmount:      PLANS[plan].amount_usd.toFixed(2),
      currency:         'USDT',
      goods: {
        goodsType:        '02',
        goodsCategory:    'Z000',
        referenceGoodsId: plan,
        goodsName:        PLANS[plan].name,
      },
      returnUrl:   `${process.env.FRONTEND_URL}/ict-bot/?payment=success&plan=${plan}`,
      cancelUrl:   `${process.env.FRONTEND_URL}/ict-bot/?payment=cancelled`,
      webhookUrl:  `${process.env.BACKEND_URL}/api/payments/binance/callback`,
    };

    const signStr = `${timestamp}\n${nonce}\n${JSON.stringify(payload)}\n`;
    const signature = crypto
      .createHmac('sha512', process.env.BINANCE_PAY_SECRET)
      .update(signStr)
      .digest('hex')
      .toUpperCase();

    const binRes = await axios.post(
      'https://bpay.binanceapi.com/binancepay/openapi/v2/order',
      payload,
      {
        headers: {
          'BinancePay-Timestamp':      timestamp,
          'BinancePay-Nonce':          nonce,
          'BinancePay-Certificate-SN': process.env.BINANCE_PAY_KEY_ID,
          'BinancePay-Signature':      signature,
          'Content-Type':              'application/json',
        }
      }
    );

    if (binRes.data.status !== 'SUCCESS') throw new Error(binRes.data.errorMessage);

    await pool.query(
      `INSERT INTO pending_payments (user_id, plan, method, checkout_request_id, created_at)
       VALUES ($1,$2,'binance',$3,NOW())`,
      [userId, plan, merchantTradeNo]
    );

    res.json({
      success:         true,
      checkoutUrl:     binRes.data.data.checkoutUrl,
      merchantTradeNo,
      message:         `Pay $${PLANS[plan].amount_usd} USDT via Binance Pay`
    });
  } catch (err) {
    console.error('Binance Pay error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Binance Pay failed. Try again.' });
  }
};

exports.binanceCallback = async (req, res) => {
  try {
    const { bizType, data } = req.body;
    if (bizType === 'PAY' && data?.status === 'PAY_SUCCESS') {
      const orderData = JSON.parse(data.orderData || '{}');
      const pending   = await pool.query(
        'SELECT user_id, plan FROM pending_payments WHERE checkout_request_id = $1',
        [orderData.merchantTradeNo]
      );
      if (pending.rows.length) {
        await activatePlan(pending.rows[0].user_id, pending.rows[0].plan,
          orderData.transactionId, 'binance', orderData.orderAmount);
        await pool.query('DELETE FROM pending_payments WHERE checkout_request_id = $1', [orderData.merchantTradeNo]);
      }
    }
    res.json({ returnCode: 'SUCCESS', returnMessage: null });
  } catch (err) {
    res.json({ returnCode: 'SUCCESS', returnMessage: null });
  }
};

// ═══════════════════════════════════════════════════════════
//  4. OKX PAY
// ═══════════════════════════════════════════════════════════
exports.okxPay = async (req, res) => {
  try {
    const { plan } = req.body;
    const userId   = req.user.id;

    if (!PLANS[plan]) return res.status(400).json({ success: false, message: 'Invalid plan.' });

    const timestamp   = new Date().toISOString();
    const orderId     = `APEX-OKX-${Date.now()}-${userId.slice(0,6)}`;
    const requestPath = '/api/v5/mktplace/nft/ordinals/create-order';
    const body        = JSON.stringify({
      orderId,
      amount:      PLANS[plan].amount_usd.toString(),
      currency:    'USDT',
      product:     PLANS[plan].name,
      callbackUrl: `${process.env.BACKEND_URL}/api/payments/okx/callback`,
      redirectUrl: `${process.env.FRONTEND_URL}/ict-bot/?payment=success&plan=${plan}`,
    });

    const sign = crypto
      .createHmac('sha256', process.env.OKX_SECRET_KEY)
      .update(`${timestamp}GET${requestPath}${body}`)
      .digest('base64');

    const okxRes = await axios.post(
      `https://www.okx.com${requestPath}`,
      JSON.parse(body),
      {
        headers: {
          'OK-ACCESS-KEY':        process.env.OKX_API_KEY,
          'OK-ACCESS-SIGN':       sign,
          'OK-ACCESS-TIMESTAMP':  timestamp,
          'OK-ACCESS-PASSPHRASE': process.env.OKX_PASSPHRASE,
          'Content-Type':         'application/json',
        }
      }
    );

    await pool.query(
      `INSERT INTO pending_payments (user_id, plan, method, checkout_request_id, created_at)
       VALUES ($1,$2,'okx',$3,NOW())`,
      [userId, plan, orderId]
    );

    res.json({
      success:    true,
      paymentUrl: okxRes.data?.data?.paymentUrl || `https://www.okx.com/pay/${orderId}`,
      orderId,
      message:    `Pay $${PLANS[plan].amount_usd} USDT via OKX Pay`
    });
  } catch (err) {
    console.error('OKX error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'OKX Pay failed. Try again.' });
  }
};

exports.okxCallback = async (req, res) => {
  try {
    const { orderId, status, transactionHash } = req.body;
    if (status === 'SUCCESS') {
      const pending = await pool.query(
        'SELECT user_id, plan FROM pending_payments WHERE checkout_request_id = $1', [orderId]
      );
      if (pending.rows.length) {
        await activatePlan(pending.rows[0].user_id, pending.rows[0].plan,
          transactionHash || orderId, 'okx', PLANS[pending.rows[0].plan].amount_usd);
        await pool.query('DELETE FROM pending_payments WHERE checkout_request_id = $1', [orderId]);
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: true });
  }
};

// ═══════════════════════════════════════════════════════════
//  GET SUBSCRIPTION STATUS
// ═══════════════════════════════════════════════════════════
exports.getSubscription = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.plan, u.subscription_end_date,
              s.payment_method, s.started_at, s.amount_paid, s.payment_reference
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       WHERE u.id = $1
       ORDER BY s.created_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json({ success: true, subscription: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};
