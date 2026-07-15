const express = require('express');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let firebaseReady = false;
let messaging = null;
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
    firebaseReady = true;
    console.log('Firebase Admin başlatıldı.');
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
const users = {};

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

async function fetchRealRoute(mode, lat1, lon1, lat2, lon2) {
  const profilePath = mode === 'yaya' ? 'routed-foot/route/v1/foot' : 'routed-car/route/v1/driving';
  const url = `https://routing.openstreetmap.de/${profilePath}/${lon1},${lat1};${lon2},${lat2}?overview=false`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes || !data.routes[0]) return null;
    return {
      distanceMeters: data.routes[0].distance,
      durationSeconds: data.routes[0].duration,
    };
  } catch (err) {
    console.error('OSRM rota hatası:', err.message);
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
    session.routeSource = 'osrm';
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

app.post('/api/register', (req, res) => {
  const { phone, name, fcmToken } = req.body;
  const normalized = normalizePhone(phone);
  if (!normalized || !name) {
    return res.status(400).json({ error: 'Geçersiz isim veya telefon' });
  }
  users[normalized] = { name, fcmToken: fcmToken || null };
  res.json({ ok: true });
});

app.post('/api/update-token', (req, res) => {
  const { phone, fcmToken } = req.body;
  const normalized = normalizePhone(phone);
  if (!normalized || !users[normalized]) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  users[normalized].fcmToken = fcmToken;
  res.json({ ok: true });
});

app.post('/api/match-contacts', (req, res) => {
  const { phones } = req.body;
  if (!Array.isArray(phones)) return res.status(400).json({ error: 'phones bir liste olmalı' });

  const matches = [];
  for (const p of phones) {
    const normalized = normalizePhone(p);
    if (users[normalized]) {
      matches.push({ phone: normalized, name: users[normalized].name });
    }
  }
  res.json({ matches });
});

app.post('/api/invite', async (req, res) => {
  const { fromName, fromPhone, toPhone, mode, thresholdMin } = req.body;
  const normalizedTo = normalizePhone(toPhone);
  const target = users[normalizedTo];

  if (!target) return res.status(404).json({ error: 'Kişi kayıtlı değil' });
  if (!DURATIONS['600'] || !SPEEDS[mode]) return res.status(400).json({ error: 'Geçersiz mod' });

  const inviteId = generateCode();
  sessions[inviteId] = {
    travelerLoc: null,
    destLoc: null,
    mode,
    note: '',
    createdAt: Date.now(),
    expiresAt: Date.now() + DURATIONS['600'],
    subscription: null,
    fcmToken: null,
    notifyThresholdMin: (thresholdMin && thresholdMin >= 1 && thresholdMin <= 10) ? thresholdMin : 1,
    notified: false,
    accepted: false,
    fromName: fromName || 'Biri',
  };

  if (firebaseReady && messaging && target.fcmToken) {
    try {
      await messaging.send({
        token: target.fcmToken,
        notification: {
          title: 'Canlı Konum Daveti',
          body: `${fromName || 'Biri'} sizinle canlı konumunu paylaşmak istiyor`,
        },
        data: {
          type: 'invite',
          inviteId,
          fromName: fromName || 'Biri',
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

app.post('/api/location/:code', async (req, res) => {
  const session = sessions[req.params.code];
  if (!session) return res.status(404).json({ error: 'Oturum bulunamadı' });
  if (Date.now() > session.expiresAt) return res.status(410).json({ error: 'Süre doldu' });

  const { lat, lon, note } = req.body;
  session.travelerLoc = { lat, lon, updatedAt: Date.now() };
  if (typeof note === 'string') session.note = note.slice(0, 100);

  await refreshRoute(session);
  await maybeNotify(session);

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
    note: session.note || '',
    mode: session.mode,
    expiresAt: session.expiresAt,
  });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY || null });
});

async function maybeNotify(session) {
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
          data: { title, body },
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
