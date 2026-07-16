const express = require('express');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let firebaseReady = false;
let messaging = null;
let db = null;
try {
  const secretFilePath = '/etc/secrets/firebase-service-account.json';
  let serviceAccount = null;

  if (fs.existsSync(secretFilePath)) {
    serviceAccount = JSON.parse(fs.readFileSync(secretFilePath, 'utf8'));
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }

  if (serviceAccount) {
    initializeApp({ credential: cert(serviceAccount) });
    messaging = getMessaging();
    db = getFirestore();
    firebaseReady = true;
    console.log('Firebase Admin başlatıldı (Firestore dahil).');
  } else {
    console.warn('Firebase servis hesabı bulunamadı, push bildirimleri devre dışı.');
  }
} catch (err) {
  console.error('Firebase Admin başlatma hatası:', err.message);
}

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:test@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const sessions = {};

function normalizePhone(raw) {
  if (!raw) return '';
  let digits = raw.replace(/[^0-9]/g, '');
  if (digits.startsWith('90') && digits.length === 12) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
  return digits;
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function straightLineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

const SPEEDS = {
  araba: 30 * 1000 / 3600,
  yaya: 5 * 1000 / 3600,
};

const TOMTOM_API_KEY = process.env.TOMTOM_API_KEY;

async function fetchRealRoute(mode, lat1, lon1, lat2, lon2) {
  if (!TOMTOM_API_KEY) {
    console.warn('TOMTOM_API_KEY tanımlı değil, yedek hesaba geçiliyor.');
    return null;
  }

  const travelMode = mode === 'yaya' ? 'pedestrian' : 'car';
  const url = `https://api.tomtom.com/routing/1/calculateRoute/${lat1},${lon1}:${lat2},${lon2}/json?key=${TOMTOM_API_KEY}&travelMode=${travelMode}&traffic=true`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const summary = data.routes?.[0]?.summary;
    if (!summary) return null;
    return {
      distanceMeters: summary.lengthInMeters,
      durationSeconds: summary.travelTimeInSeconds,
    };
  } catch (err) {
    console.error('TomTom rota hatası:', err.message);
    return null;
  }
}

async function refreshRoute(session) {
  if (!session.travelerLoc || !session.destLoc) return;

  const now = Date.now();
  if (session.routeUpdatedAt && now - session.routeUpdatedAt < 8000) return;

  const route = await fetchRealRoute(
    session.mode,
    session.travelerLoc.lat, session.travelerLoc.lon,
    session.destLoc.lat, session.destLoc.lon
  );

  if (route) {
    session.routeDistance = route.distanceMeters;
    session.routeEtaMinutes = route.durationSeconds / 60;
    session.routeUpdatedAt = now;
    session.routeSource = 'tomtom';
  } else {
    const straight = straightLineDistance(
      session.travelerLoc.lat, session.travelerLoc.lon,
      session.destLoc.lat, session.destLoc.lon
    );
    session.routeDistance = straight * 1.3;
    session.routeEtaMinutes = (session.routeDistance / SPEEDS[session.mode]) / 60;
    session.routeUpdatedAt = now;
    session.routeSource = 'fallback';
  }
}

const DURATIONS = {
  '15': 15 * 60 * 1000,
  '60': 60 * 60 * 1000,
  '600': 10 * 60 * 60 * 1000,
};

app.post('/api/register', async (req, res) => {
  const { phone, fcmToken } = req.body;
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return res.status(400).json({ error: 'Geçersiz telefon' });
  }
  if (!db) return res.status(500).json({ error: 'Veritabanı hazır değil' });

  try {
    await db.collection('users').doc(normalized).set({
      fcmToken: fcmToken || null,
      updatedAt: Date.now(),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Kayıt hatası:', err.message);
    res.status(500).json({ error: 'Kayıt başarısız' });
  }
});

app.post('/api/update-token', async (req, res) => {
  const { phone, fcmToken } = req.body;
  const normalized = normalizePhone(phone);
  if (!normalized || !db) return res.status(400).json({ error: 'Geçersiz istek' });

  try {
    const docRef = db.collection('users').doc(normalized);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    await docRef.update({ fcmToken });
    res.json({ ok: true });
  } catch (err) {
    console.error('Token güncelleme hatası:', err.message);
    res.status(500).json({ error: 'Güncelleme başarısız' });
  }
});

app.post('/api/match-contacts', async (req, res) => {
  const { phones } = req.body;
  if (!Array.isArray(phones)) return res.status(400).json({ error: 'phones bir liste olmalı' });
  if (!db) return res.status(500).json({ error: 'Veritabanı hazır değil' });

  try {
    const normalizedPhones = [...new Set(phones.map(normalizePhone).filter(Boolean))];
    if (normalizedPhones.length === 0) return res.json({ matches: [] });

    const refs = normalizedPhones.map((p) => db.collection('users').doc(p));
    const docs = await db.getAll(...refs);

    const matches = [];
    docs.forEach((doc) => {
      if (doc.exists) {
        matches.push({ phone: doc.id });
      }
    });
    res.json({ matches });
  } catch (err) {
    console.error('Eşleştirme hatası:', err.message);
    res.status(500).json({ error: 'Eşleştirme başarısız' });
  }
});

app.post('/api/invite', async (req, res) => {
  const { fromName, fromPhone, toPhone, mode, thresholdMin, destLat, destLon } = req.body;
  const normalizedTo = normalizePhone(toPhone);
  if (!db) return res.status(500).json({ error: 'Veritabanı hazır değil' });

  let target;
  try {
    const doc = await db.collection('users').doc(normalizedTo).get();
    if (!doc.exists) return res.status(404).json({ error: 'Kişi kayıtlı değil' });
    target = doc.data();
  } catch (err) {
    console.error('Davet - kullanıcı sorgu hatası:', err.message);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }

  if (!SPEEDS[mode]) return res.status(400).json({ error: 'Geçersiz mod' });

  const isFixed = typeof destLat === 'number' && typeof destLon === 'number';
  const normalizedFrom = normalizePhone(fromPhone);
  const inviteId = generateCode();
  sessions[inviteId] = {
    travelerLoc: null,
    destLoc: isFixed ? { lat: destLat, lon: destLon } : null,
    mode,
    note: '',
    createdAt: Date.now(),
    expiresAt: Date.now() + DURATIONS['600'],
    subscription: null,
    fcmToken: null,
    notifyThresholdMin: (thresholdMin && thresholdMin >= 1 && thresholdMin <= 10) ? thresholdMin : 1,
    notified: false,
    accepted: false,
    fixed: isFixed,
    fromPhone: normalizedFrom,
  };

  if (firebaseReady && messaging && target.fcmToken) {
    try {
      await messaging.send({
        token: target.fcmToken,
        notification: {
          title: 'Canlı Konum Daveti',
          body: 'Sizinle canlı konumunu paylaşmak istiyor',
        },
        data: {
          type: 'invite',
          inviteId,
          fromPhone: normalizedFrom,
          fixed: isFixed ? '1' : '0',
        },
        android: { priority: 'high' },
      });
    } catch (err) {
      console.error('Davet push hatası:', err.message);
      return res.status(500).json({ error: 'Bildirim gönderilemedi' });
    }
  } else {
    return res.status(500).json({ error: 'Bildirim sistemi hazır değil' });
  }

  res.json({ inviteId });
});

app.post('/api/invite/:id/accept-fixed', async (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Davet bulunamadı' });
  const { fcmToken } = req.body;
  session.fcmToken = fcmToken;
  session.accepted = true;
  res.json({ ok: true });
});

app.post('/api/request', async (req, res) => {
  const { fromPhone, toPhone, mode, thresholdMin, fromLat, fromLon, fcmToken } = req.body;
  const normalizedTo = normalizePhone(toPhone);
  if (!db) return res.status(500).json({ error: 'Veritabanı hazır değil' });

  let target;
  try {
    const doc = await db.collection('users').doc(normalizedTo).get();
    if (!doc.exists) return res.status(404).json({ error: 'Kişi kayıtlı değil' });
    target = doc.data();
  } catch (err) {
    console.error('İstek - kullanıcı sorgu hatası:', err.message);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }

  if (!SPEEDS[mode]) return res.status(400).json({ error: 'Geçersiz mod' });
  if (typeof fromLat !== 'number' || typeof fromLon !== 'number') {
    return res.status(400).json({ error: 'Konum bilgisi eksik' });
  }

  const normalizedFrom = normalizePhone(fromPhone);
  const inviteId = generateCode();
  sessions[inviteId] = {
    travelerLoc: null,
    destLoc: { lat: fromLat, lon: fromLon },
    mode,
    note: '',
    createdAt: Date.now(),
    expiresAt: Date.now() + DURATIONS['600'],
    subscription: null,
    fcmToken: fcmToken || null,
    notifyThresholdMin: (thresholdMin && thresholdMin >= 1 && thresholdMin <= 10) ? thresholdMin : 1,
    notified: false,
    accepted: false,
    kind: 'request',
    fromPhone: normalizedFrom,
  };

  if (firebaseReady && messaging && target.fcmToken) {
    try {
      await messaging.send({
        token: target.fcmToken,
        notification: {
          title: 'Canlı Konum İsteği',
          body: 'Sizden canlı konumunuzu istiyor',
        },
        data: {
          type: 'request',
          inviteId,
          fromPhone: normalizedFrom,
        },
        android: { priority: 'high' },
      });
    } catch (err) {
      console.error('İstek push hatası:', err.message);
      return res.status(500).json({ error: 'Bildirim gönderilemedi' });
    }
  } else {
    return res.status(500).json({ error: 'Bildirim sistemi hazır değil' });
  }

  res.json({ inviteId });
});

app.post('/api/invite/:id/accept', async (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Davet bulunamadı' });
  const { lat, lon, fcmToken } = req.body;
  session.destLoc = { lat, lon };
  session.fcmToken = fcmToken;
  session.accepted = true;
  await refreshRoute(session);
  res.json({ ok: true });
});

app.post('/api/invite/:id/accept-request', async (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'İstek bulunamadı' });
  session.accepted = true;
  res.json({ ok: true });
});

app.post('/api/invite/:id/decline', async (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Davet bulunamadı' });
  session.declined = true;
  res.json({ ok: true });
});

app.post('/api/invite/:id/stop', async (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Oturum bulunamadı' });
  session.expiresAt = Date.now();
  res.json({ ok: true });
});

app.post('/api/invite/:id/arrived', async (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Oturum bulunamadı' });
  if (session.arrived) return res.json({ ok: true });

  session.arrived = true;

  if (firebaseReady && messaging && session.fcmToken) {
    try {
      await messaging.send({
        token: session.fcmToken,
        notification: {
          title: 'Geldi! 🎉',
          body: 'Yanınızda, şükür kavuşturana!',
        },
        data: {
          type: 'arrived',
          inviteId: req.params.id,
          fromPhone: session.fromPhone || '',
        },
        android: { priority: 'high' },
      });
    } catch (err) {
      console.error('Varış push hatası:', err.message);
    }
  }

  res.json({ ok: true });
});

app.post('/api/location/:code', async (req, res) => {
  const session = sessions[req.params.code];
  if (!session) return res.status(404).json({ error: 'Oturum bulunamadı' });
  if (Date.now() > session.expiresAt) return res.status(410).json({ error: 'Süre doldu' });

  const { lat, lon, note } = req.body;
  session.travelerLoc = { lat, lon, updatedAt: Date.now() };
  if (typeof note === 'string') session.note = note.slice(0, 100);

  await refreshRoute(session);
  await maybeNotify(session, req.params.code);

  res.json({ ok: true });
});

app.post('/api/destination/:code', async (req, res) => {
  const session = sessions[req.params.code];
  if (!session) return res.status(404).json({ error: 'Oturum bulunamadı' });
  const { lat, lon } = req.body;
  session.destLoc = { lat, lon };
  await refreshRoute(session);
  res.json({ ok: true });
});

app.post('/api/subscribe/:code', (req, res) => {
  const session = sessions[req.params.code];
  if (!session) return res.status(404).json({ error: 'Oturum bulunamadı' });
  session.subscription = req.body.subscription;
  res.json({ ok: true });
});

app.post('/api/register-token/:code', (req, res) => {
  const session = sessions[req.params.code];
  if (!session) return res.status(404).json({ error: 'Oturum bulunamadı' });
  session.fcmToken = req.body.token;
  res.json({ ok: true });
});

app.get('/api/status/:code', (req, res) => {
  const session = sessions[req.params.code];
  if (!session) return res.status(404).json({ error: 'Oturum bulunamadı' });

  const active = Date.now() <= session.expiresAt;

  res.json({
    active,
    distance: session.routeDistance ?? null,
    etaMinutes: session.routeEtaMinutes ?? null,
    routeSource: session.routeSource ?? null,
    travelerLoc: session.travelerLoc,
    destLoc: session.destLoc,
    note: session.note || '',
    mode: session.mode,
    arrived: session.arrived || false,
    accepted: session.accepted || false,
    declined: session.declined || false,
    expiresAt: session.expiresAt,
  });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY || null });
});

async function maybeNotify(session, sessionCode) {
  if (session.notified) return;
  if (!session.travelerLoc || !session.destLoc) return;
  if (session.routeEtaMinutes == null) return;

  const etaMinutes = session.routeEtaMinutes;
  const threshold = session.notifyThresholdMin || 1;

  if (etaMinutes <= threshold) {
    session.notified = true;

    const title = 'Yaklaşıyor!';
    const noteText = session.note ? ` ("${session.note}")` : '';
    const body = `${threshold} dakika sonra yanınızda olacak${noteText}`;

    if (firebaseReady && messaging && session.fcmToken) {
      try {
        await messaging.send({
          token: session.fcmToken,
          notification: { title, body },
          data: { title, body, type: 'threshold', inviteId: sessionCode || '' },
          android: { priority: 'high' },
        });
      } catch (err) {
        console.error('FCM gönderim hatası:', err.message);
      }
    }

    if (session.subscription) {
      const payload = JSON.stringify({ title, body });
      webpush.sendNotification(session.subscription, payload).catch((err) => {
        console.error('Web push gönderim hatası:', err.message);
      });
    }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const code in sessions) {
    if (now - sessions[code].expiresAt > 60 * 60 * 1000) {
      delete sessions[code];
    }
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor`));
