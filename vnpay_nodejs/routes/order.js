/**
 * routes/order.js - Fixed for VNPAY signature (encode values -> spaces as +)
 */

const express = require('express');
const router = express.Router();
const request = require('request');
const moment = require('moment');
const qs = require('qs');
const crypto = require('crypto');
const config = require('config');

/**
 * Helper: normalize IP (for local testing)
 */
function normalizeIp(rawIp) {
  if (!rawIp) return '127.0.0.1';
  let ip = rawIp;
  if (Array.isArray(ip)) ip = ip[0];
  ip = String(ip);
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

/**
 * sortObjectForVNP:
 * - Input: obj with raw values (decoded)
 * - Output: object with SAME keys, but values encoded as encodeURIComponent(value).replace(/%20/g, '+')
 * - Keys are left as-is (ASCII keys like vnp_OrderInfo remain unchanged)
 *
 * We will call qs.stringify(sorted, { encode: false }) afterwards.
 */
function sortObjectForVNP(obj) {
  const keys = Object.keys(obj || {});
  keys.sort();
  const sorted = {};
  keys.forEach(k => {
    // ensure value is string
    const rawVal = obj[k] === undefined || obj[k] === null ? '' : String(obj[k]);
    // encode value then replace %20 -> +
    const encodedVal = encodeURIComponent(rawVal).replace(/%20/g, '+');
    sorted[k] = encodedVal;
  });
  return sorted;
}

/* ---------- Views ---------- */
router.get('/', function(req, res, next){
  res.render('orderlist', { title: 'Danh sách đơn hàng' });
});

router.get('/create_payment_url', function (req, res, next) {
  res.render('order', { title: 'Tạo mới đơn hàng', amount: 10000 });
});

router.get('/querydr', function (req, res, next) {
  res.render('querydr', { title: 'Truy vấn kết quả thanh toán' });
});

router.get('/refund', function (req, res, next) {
  res.render('refund', { title: 'Hoàn tiền giao dịch thanh toán' });
});

/* ---------- Create Payment (POST) ---------- */
router.post('/create_payment_url', function (req, res, next) {
  try {
    process.env.TZ = 'Asia/Ho_Chi_Minh';
    const date = new Date();
    const createDate = moment(date).format('YYYYMMDDHHmmss');

    // Normalize IP
    let ipAddr = req.headers['x-forwarded-for'] ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      (req.connection && req.connection.socket && req.connection.socket.remoteAddress) ||
      '127.0.0.1';
    ipAddr = normalizeIp(ipAddr);

    // Load config
    const tmnCode = config.get('vnp_TmnCode');
    const secretKey = config.get('vnp_HashSecret');
    const vnpUrl = config.get('vnp_Url');
    const returnUrl = config.get('vnp_ReturnUrl');

    // Debug check secret presence
    if (!secretKey || !tmnCode) {
      console.error('[ERR] missing VNPAY config: tmnCode or secretKey');
      return res.status(500).json({ ok: false, message: 'Missing config' });
    }

    // Amount and other inputs
    const amountRaw = Number(req.body.amount) || 0;
    const amount = Math.round(amountRaw);
    const amountPay = (amount * 100).toString(); // VNPAY expects amount*100

    // Bank code uppercase (avoid case mismatch)
    const bankCodeRaw = (req.body.bankCode || '').toString().trim();
    const bankCode = bankCodeRaw ? bankCodeRaw.toUpperCase() : '';

    const locale = (req.body.language || 'vn').toString().trim() || 'vn';

    // Order reference
    const orderId = moment(date).format('DDHHmmss');
    const orderInfo = 'Thanh toan cho ma GD:' + orderId;

    // Build raw params (values NOT encoded)
    const vnp_Params_raw = {
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: tmnCode,
      vnp_Locale: locale,
      vnp_CurrCode: 'VND',
      vnp_TxnRef: orderId,
      vnp_OrderInfo: orderInfo,
      vnp_OrderType: 'other',
      vnp_Amount: amountPay,
      vnp_ReturnUrl: returnUrl,
      vnp_IpAddr: ipAddr,
      vnp_CreateDate: createDate
    };
    if (bankCode) vnp_Params_raw.vnp_BankCode = bankCode;

    // Use VNP-style sort & encode values (spaces -> +)
    const sortedForSign = sortObjectForVNP(vnp_Params_raw);

    // Build signData string: keys sorted, values encoded (we already encoded values)
    const signData = qs.stringify(sortedForSign, { encode: false });
    const hmac = crypto.createHmac('sha512', secretKey);
    const signature = hmac.update(Buffer.from(signData, 'utf-8')).digest('hex');

    // Debug logs
    console.log('[CREATE] signData:', signData);
    console.log('[CREATE] signed:', signature);

    // Add signature to params (signature is hex string; no extra encoding)
    sortedForSign['vnp_SecureHash'] = signature;

    // Build final paymentUrl (sortedForSign already has encoded values)
    const paymentUrl = vnpUrl + '?' + qs.stringify(sortedForSign, { encode: false });

    console.log('[DEBUG] paymentUrl=', paymentUrl);

    // Detect AJAX robustly
    function isAjaxRequest(req) {
      const accept = (req.headers['accept'] || '').toLowerCase();
      const xrw = (req.headers['x-requested-with'] || '').toLowerCase();
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (xrw === 'xmlhttprequest') return true;
      if (accept.includes('application/json')) return true;
      if (ct.includes('application/json')) return true;
      if (req.query && req.query.ajax === '1') return true;
      return false;
    }

    if (isAjaxRequest(req)) {
      return res.json({ ok: true, paymentUrl });
    } else {
      return res.redirect(paymentUrl);
    }
  } catch (err) {
    console.error('[ERR create_payment_url]', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

/* ---------- Return (user redirect) ---------- */
router.get('/vnpay_return', function (req, res, next) {
  try {
    // Copy query object (express already decodes percent-encoding)
    const vnp_Params = Object.assign({}, req.query || {});
    const secureHashFromQuery = vnp_Params['vnp_SecureHash'];

    // remove secure hash fields before verification
    delete vnp_Params['vnp_SecureHash'];
    delete vnp_Params['vnp_SecureHashType'];

    // For verification, we MUST encode values exactly like when creating:
    // use sortObjectForVNP to encode values (spaces->+), then stringify
    const sortedForVerify = sortObjectForVNP(vnp_Params);
    const signData = qs.stringify(sortedForVerify, { encode: false });

    const secretKey = config.get('vnp_HashSecret');
    const hmac = crypto.createHmac('sha512', secretKey);
    const signed = hmac.update(Buffer.from(signData, 'utf-8')).digest('hex');

    // Debug logs for comparison
    console.log('[RETURN] signData:', signData);
    console.log('[RETURN] signed:', signed, 'secureHashFromQuery:', secureHashFromQuery);

    if (secureHashFromQuery === signed) {
      // success
      return res.render('success', { code: sortedForVerify['vnp_ResponseCode'] || '00', data: sortedForVerify });
    } else {
      // checksum failed
      return res.render('success', { code: '97', data: sortedForVerify });
    }
  } catch (err) {
    console.error('[ERR vnpay_return]', err);
    return res.status(500).send('Server error');
  }
});

/* ---------- IPN (server-to-server) ---------- */
router.get('/vnpay_ipn', function (req, res, next) {
  try {
    const vnp_Params = Object.assign({}, req.query || {});
    const secureHashFromQuery = vnp_Params['vnp_SecureHash'];

    delete vnp_Params['vnp_SecureHash'];
    delete vnp_Params['vnp_SecureHashType'];

    const sortedForVerify = sortObjectForVNP(vnp_Params);
    const signData = qs.stringify(sortedForVerify, { encode: false });

    const secretKey = config.get('vnp_HashSecret');
    const hmac = crypto.createHmac('sha512', secretKey);
    const signed = hmac.update(Buffer.from(signData, 'utf-8')).digest('hex');

    console.log('[IPN] signData:', signData);
    console.log('[IPN] signed:', signed, 'secureHashFromQuery:', secureHashFromQuery);

    if (secureHashFromQuery === signed) {
      const rspCode = sortedForVerify['vnp_ResponseCode'];
      // TODO: verify order existence and amount in DB, idempotency
      return res.status(200).json({ RspCode: '00', Message: 'Success' });
    } else {
      return res.status(200).json({ RspCode: '97', Message: 'Checksum failed' });
    }
  } catch (err) {
    console.error('[ERR vnpay_ipn]', err);
    return res.status(500).json({ RspCode: '99', Message: 'Server error' });
  }
});

/* ---------- QueryDR and Refund (kept but use Buffer.from) ---------- */
router.post('/querydr', function (req, res, next) {
  try {
    process.env.TZ = 'Asia/Ho_Chi_Minh';
    const date = new Date();

    const vnp_TmnCode = config.get('vnp_TmnCode');
    const secretKey = config.get('vnp_HashSecret');
    const vnp_Api = config.get('vnp_Api');

    const vnp_TxnRef = req.body.orderId;
    const vnp_TransactionDate = req.body.transDate;

    const vnp_RequestId = moment(date).format('HHmmss');
    const vnp_Version = '2.1.0';
    const vnp_Command = 'querydr';
    const vnp_OrderInfo = 'Truy van GD ma:' + vnp_TxnRef;

    let vnp_IpAddr = req.headers['x-forwarded-for'] ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      (req.connection && req.connection.socket && req.connection.socket.remoteAddress) ||
      '127.0.0.1';
    vnp_IpAddr = normalizeIp(vnp_IpAddr);

    const vnp_CreateDate = moment(date).format('YYYYMMDDHHmmss');

    const data = vnp_RequestId + "|" + vnp_Version + "|" + vnp_Command + "|" + vnp_TmnCode + "|" + vnp_TxnRef + "|" + vnp_TransactionDate + "|" + vnp_CreateDate + "|" + vnp_IpAddr + "|" + vnp_OrderInfo;

    const hmac = crypto.createHmac('sha512', secretKey);
    const vnp_SecureHash = hmac.update(Buffer.from(data, 'utf-8')).digest('hex');

    const dataObj = {
      'vnp_RequestId': vnp_RequestId,
      'vnp_Version': vnp_Version,
      'vnp_Command': vnp_Command,
      'vnp_TmnCode': vnp_TmnCode,
      'vnp_TxnRef': vnp_TxnRef,
      'vnp_OrderInfo': vnp_OrderInfo,
      'vnp_TransactionDate': vnp_TransactionDate,
      'vnp_CreateDate': vnp_CreateDate,
      'vnp_IpAddr': vnp_IpAddr,
      'vnp_SecureHash': vnp_SecureHash
    };

    request({
      url: vnp_Api,
      method: "POST",
      json: true,
      body: dataObj
    }, function (error, response, body) {
      console.log('[querydr] response status:', response && response.statusCode);
      console.log('[querydr] body:', body);
      return res.json({ ok: true, data: body });
    });

  } catch (err) {
    console.error('[ERR querydr]', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

router.post('/refund', function (req, res, next) {
  try {
    process.env.TZ = 'Asia/Ho_Chi_Minh';
    const date = new Date();

    const vnp_TmnCode = config.get('vnp_TmnCode');
    const secretKey = config.get('vnp_HashSecret');
    const vnp_Api = config.get('vnp_Api');

    const vnp_TxnRef = req.body.orderId;
    const vnp_TransactionDate = req.body.transDate;
    const vnp_Amount = Number(req.body.amount || 0) * 100;
    const vnp_TransactionType = req.body.transType;
    const vnp_CreateBy = req.body.user || '';

    let vnp_IpAddr = req.headers['x-forwarded-for'] ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      (req.connection && req.connection.socket && req.connection.socket.remoteAddress) ||
      '127.0.0.1';
    vnp_IpAddr = normalizeIp(vnp_IpAddr);

    const vnp_RequestId = moment(date).format('HHmmss');
    const vnp_Version = '2.1.0';
    const vnp_Command = 'refund';
    const vnp_OrderInfo = 'Hoan tien GD ma:' + vnp_TxnRef;
    const vnp_CreateDate = moment(date).format('YYYYMMDDHHmmss');
    const vnp_TransactionNo = '0';

    const data = vnp_RequestId + "|" + vnp_Version + "|" + vnp_Command + "|" + vnp_TmnCode + "|" + vnp_TransactionType + "|" + vnp_TxnRef + "|" + vnp_Amount + "|" + vnp_TransactionNo + "|" + vnp_TransactionDate + "|" + vnp_CreateBy + "|" + vnp_CreateDate + "|" + vnp_IpAddr + "|" + vnp_OrderInfo;
    const hmac = crypto.createHmac('sha512', secretKey);
    const vnp_SecureHash = hmac.update(Buffer.from(data, 'utf-8')).digest('hex');

    const dataObj = {
      'vnp_RequestId': vnp_RequestId,
      'vnp_Version': vnp_Version,
      'vnp_Command': vnp_Command,
      'vnp_TmnCode': vnp_TmnCode,
      'vnp_TransactionType': vnp_TransactionType,
      'vnp_TxnRef': vnp_TxnRef,
      'vnp_Amount': vnp_Amount,
      'vnp_TransactionNo': vnp_TransactionNo,
      'vnp_CreateBy': vnp_CreateBy,
      'vnp_OrderInfo': vnp_OrderInfo,
      'vnp_TransactionDate': vnp_TransactionDate,
      'vnp_CreateDate': vnp_CreateDate,
      'vnp_IpAddr': vnp_IpAddr,
      'vnp_SecureHash': vnp_SecureHash
    };

    request({
      url: vnp_Api,
      method: "POST",
      json: true,
      body: dataObj
    }, function (error, response, body) {
      console.log('[refund] response status:', response && response.statusCode);
      console.log('[refund] body:', body);
      return res.json({ ok: true, data: body });
    });

  } catch (err) {
    console.error('[ERR refund]', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

module.exports = router;
