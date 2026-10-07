const express = require('express');
const crypto = require('crypto');
const { promisify } = require('util');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const SESSION_SECRET = process.env.AUTH_SESSION_SECRET || '';
const PAYSTACK_FEE_RATE = 0.0195;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUSINESS_PHONE = '0597601733';
const scryptAsync = promisify(crypto.scrypt);

const PRODUCTS = {
  'viora-dish-450-yellow': { name: 'Viora Dishwashing Liquid Soap', variant: '450ml', colorLabel: 'Yellow', price: 13 },
  'viora-dish-450-green': { name: 'Viora Dishwashing Liquid Soap', variant: '450ml', colorLabel: 'Green', price: 13 },
  'viora-dish-450-orange': { name: 'Viora Dishwashing Liquid Soap', variant: '450ml', colorLabel: 'Orange', price: 13 },
  'viora-dish-5l': { name: 'Viora Dishwashing Liquid Soap', variant: '5 Litres', price: 65 },
  'viora-fabric-500-blue': { name: 'Viora Fabric Softener', variant: '500ml', colorLabel: 'Blue', price: 20 },
  'viora-fabric-500-pink': { name: 'Viora Fabric Softener', variant: '500ml', colorLabel: 'Pink', price: 20 },
  'viora-bleach-1l': { name: 'Viora Thick Perfumed Bleach', variant: '1 Litre', price: 20 },
  'viora-floor-5l': { name: 'Viora Floor Cleaner', variant: '5 Litres', price: null, byOrder: true }
};

const db = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
const path = require('path');
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.get('/styles.css', (_req, res) => res.sendFile(path.join(__dirname, 'styles.css')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function jsonError(res, status, message) { return res.status(status).json({ error: message }); }
function money(n) { return `GHS ${Number(n || 0).toFixed(2)}`; }
function paystackGross(net) { return net <= 0 ? 0 : Math.round(((net / (1 - PAYSTACK_FEE_RATE)) + 0.01) * 100) / 100; }

async function requireDb(res) {
  if (!db) { jsonError(res, 503, 'Customer accounts and order records need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be configured in Render.'); return false; }
  return true;
}

async function initDb() {
  if (!db) { console.warn('Supabase is not configured. Accounts and order records are disabled.'); return; }
  const { error } = await db.from('orders').select('reference', { head: true, count: 'exact' }).limit(1);
  if (error) console.error('Supabase check failed — have you run supabase/schema.sql in the SQL editor?', error.message);
  else console.log('Supabase connected; tables found.');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const derived = Buffer.from(await scryptAsync(password, parts[1], expected.length, { N: 16384, r: 8, p: 1 }));
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}
function createSession(user) {
  const payload = { uid: user.id, exp: Math.floor(Date.now() / 1000) + 30 * 86400 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}
function parseCookies(header) {
  return String(header || '').split(';').reduce((out, part) => {
    const i = part.indexOf('='); if (i < 0) return out;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); return out;
  }, {});
}
function readSession(req) {
  if (!SESSION_SECRET) return null;
  const token = parseCookies(req.headers.cookie).pureglow_session;
  if (!token) return null;
  const dot = token.lastIndexOf('.'); if (dot <= 0) return null;
  const encoded = token.slice(0, dot), signature = token.slice(dot + 1);
  const expected = sign(encoded);
  try {
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch { return null; }
}
function setSession(res, token) {
  res.setHeader('Set-Cookie', `pureglow_session=${encodeURIComponent(token)}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', 'pureglow_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
}
function publicUser(u) { return { id: u.id, name: u.name, phone: u.phone }; }

app.get('/health', (_req, res) => res.json({ ok: true, service: 'PureGlow Solutions', database: Boolean(db), paystack: Boolean(PAYSTACK_SECRET_KEY), orders: Boolean(db) }));

app.get('/api/auth', async (req, res) => {
  if (!(await requireDb(res))) return;
  if (req.query.action !== 'me') return jsonError(res, 405, 'Method not allowed.');
  const session = readSession(req);
  if (!session) return res.status(401).json({ authenticated: false });
  const { data, error } = await db.from('customers').select('id,name,phone').eq('id', session.uid).maybeSingle();
  if (error || !data) return res.status(401).json({ authenticated: false });
  return res.json({ authenticated: true, user: publicUser(data) });
});

app.post('/api/auth', async (req, res) => {
  if (!(await requireDb(res))) return;
  if (!SESSION_SECRET) return jsonError(res, 503, 'AUTH_SESSION_SECRET is not configured in Render.');
  const action = req.query.action;
  const body = req.body || {};

  if (action === 'logout') { clearSession(res); return res.json({ ok: true }); }

  if (action === 'signup') {
    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').trim();
    const password = String(body.password || '');
    if (name.length < 2) return jsonError(res, 400, 'Please enter your full name.');
    if (phone.length < 7) return jsonError(res, 400, 'Please enter a valid phone number.');
    if (password.length < 8) return jsonError(res, 400, 'Password must be at least 8 characters.');
    const exists = await db.from('customers').select('id').eq('phone', phone).maybeSingle();
    if (exists.data) return jsonError(res, 409, 'An account with that phone number already exists. Please log in.');
    const id = 'CUS-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const password_hash = await hashPassword(password);
    const ins = await db.from('customers').insert({ id, name, phone, password_hash }).select('id,name,phone').single();
    if (ins.error) { console.error(ins.error); return jsonError(res, 500, 'Could not create your account. Please try again.'); }
    setSession(res, createSession(ins.data));
    return res.status(201).json({ ok: true, user: publicUser(ins.data) });
  }

  if (action === 'login') {
    const phone = String(body.phone || '').trim(), password = String(body.password || '');
    if (phone.length < 7 || !password) return jsonError(res, 400, 'Enter your phone number and password.');
    const { data } = await db.from('customers').select('id,name,phone,password_hash').eq('phone', phone).maybeSingle();
    if (!data || !(await verifyPassword(password, data.password_hash))) return jsonError(res, 401, 'Incorrect phone number or password.');
    setSession(res, createSession(data));
    return res.json({ ok: true, user: publicUser(data) });
  }
  return jsonError(res, 405, 'Method not allowed.');
});

app.post('/api/payments/initialize', async (req, res) => {
  if (!PAYSTACK_SECRET_KEY) return jsonError(res, 503, 'Paystack is not configured. Add PAYSTACK_SECRET_KEY to Render environment variables.');
  const { name, phone, items, delivery } = req.body || {};
  if (!String(name || '').trim()) return jsonError(res, 400, 'Full name is required.');
  if (!String(phone || '').trim()) return jsonError(res, 400, 'WhatsApp/phone number is required.');
  if (!Array.isArray(items) || !items.length) return jsonError(res, 400, 'Your cart is empty.');

  const method = delivery?.method === 'cape-coast-delivery'
    ? 'Cape Coast delivery'
    : 'Collection — PureGlow Solutions, Kakumdo, Cape Coast';

  if (method === 'Cape Coast delivery' &&
      (!String(delivery?.area || '').trim() || !String(delivery?.address || '').trim())) {
    return jsonError(res, 400, 'Please provide your delivery area and address.');
  }

  let subtotal = 0;
  const lineItems = [];
  for (const raw of items) {
    const product = PRODUCTS[raw?.id];
    const qty = Math.max(1, Math.min(999, parseInt(raw?.quantity, 10) || 0));
    if (!product || !qty) return jsonError(res, 400, `Product ${raw?.id || ''} is not available.`);
    if (product.byOrder || product.price == null) {
      return jsonError(res, 400, `${product.name} is handled by order. Please use the WhatsApp order button for this item.`);
    }
    const lineTotal = Math.round(product.price * qty * 100) / 100;
    subtotal += lineTotal;
    lineItems.push({
      id: raw.id, name: product.name, variant: product.variant, colorLabel: product.colorLabel || '',
      qty, unitPrice: product.price, lineTotal
    });
  }

  subtotal = Math.round(subtotal * 100) / 100;
  const total = paystackGross(subtotal);
  const fee = Math.round((total - subtotal) * 100) / 100;
  const reference = 'PGS-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const session = readSession(req);

  const metadata = {
    customer_name: String(name).trim(),
    customer_phone: String(phone).trim(),
    fulfilment_method: method,
    delivery_area: String(delivery?.area || '').trim(),
    delivery_address: String(delivery?.address || '').trim(),
    delivery_landmark: String(delivery?.landmark || '').trim(),
    delivery_map_link: String(delivery?.mapLink || '').trim(),
    items: lineItems,
    subtotal, fee, total, customer_id: session?.uid || ''
  };

  // Paystack requires an email when initializing a transaction. The customer is
  // never asked for or shown an email; this is only a technical placeholder.
  const paystackEmail = `checkout-${reference.toLowerCase()}@pureglowsolutions.com`;

  try {
    const ps = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: paystackEmail,
        amount: Math.round(total * 100),
        currency: 'GHS',
        reference,
        metadata,
        channels: ['card','mobile_money','bank','ussd','qr','bank_transfer']
      })
    });
    const data = await ps.json();
    if (!ps.ok || !data.status) return jsonError(res, 502, data.message || 'Paystack could not start this payment.');
    return res.json({ access_code: data.data.access_code, reference: data.data.reference, authorization_url: data.data.authorization_url });
  } catch (err) {
    console.error(err);
    return jsonError(res, 502, 'Could not reach Paystack right now. Please try again.');
  }
});

// ---------- Paid order records ----------
async function recordPaidOrder(tx) {
  if (!db) return 'unavailable';
  const md = tx.metadata || {};
  const reference = tx.reference;
  const row = {
    reference,
    customer_id: md.customer_id || null,
    customer_name: md.customer_name || '',
    customer_email: null,
    customer_phone: md.customer_phone || '',
    fulfilment_method: md.fulfilment_method || '',
    delivery_area: md.delivery_area || '',
    delivery_address: md.delivery_address || '',
    delivery_landmark: md.delivery_landmark || '',
    delivery_map_link: md.delivery_map_link || '',
    items: md.items || [],
    subtotal: Number(md.subtotal || 0),
    fee: Number(md.fee || 0),
    total: Number(tx.amount || 0) / 100,
    paid_at: tx.paid_at || new Date().toISOString()
  };
  const ins = await db.from('orders').upsert(row, { onConflict: 'reference', ignoreDuplicates: true });
  if (ins.error) {
    console.error('Order save failed:', ins.error.message);
    return 'unavailable';
  }
  return 'saved';
}

app.get('/api/payments/verify', async (req, res) => {
  if (!PAYSTACK_SECRET_KEY) return jsonError(res, 503, 'Paystack is not configured.');
  const reference = String(req.query.reference || '').trim();
  if (!reference) return jsonError(res, 400, 'Missing payment reference.');
  try {
    const ps = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });
    const data = await ps.json();
    if (!ps.ok || !data.data) return res.json({ status: 'pending', reference });
    const tx = data.data;
    let orderStatus = null;
    if (tx.status === 'success') orderStatus = await recordPaidOrder(tx);
    return res.json({ status: tx.status, reference, amount: tx.amount, orderStatus, metadata: tx.metadata || {} });
  } catch (err) {
    console.error(err); return res.json({ status: 'pending', reference });
  }
});

// Paystack webhook — set this URL in Paystack Dashboard > Settings > API Keys & Webhooks
app.post('/api/payments/webhook', async (req, res) => {
  const sig = req.headers['x-paystack-signature'];
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.rawBody || Buffer.from('')).digest('hex');
  if (!PAYSTACK_SECRET_KEY || !sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.sendStatus(401);
  res.sendStatus(200);
  try { if (req.body?.event === 'charge.success' && req.body.data?.status === 'success') await recordPaidOrder(req.body.data); }
  catch (e) { console.error('Webhook error:', e); }
});


app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

initDb().catch(err => console.error('Supabase init error:', err)).finally(() => app.listen(PORT, () => console.log(`PureGlow running on port ${PORT}`)));
