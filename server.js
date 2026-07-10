const express = require('express');
const path = require('path');
const webpush = require('web-push');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- VAPID (push bildirimi için kimlik anahtarları) ----
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:test@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const sessions = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Haversine formülü: iki koordinat arası KUŞ UÇUŞU mesafe (metre) - sadece API başarısız olursa yedek
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

// ---- OSRM (OpenStreetMap) üzerinden GERÇEK yol mesafesi/süresi ----
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

app.post('/api/session', (req, res) => {
  const { duration, mode, destLat, destLon } = req.body;
  if (!DURATIONS[duration] || !SPEEDS[mode]) {
    return res.status(400).json({ error: 'Geçersiz süre veya mod' });
  }
  const code = generateCode();
  sessions[code] = {
    travelerLoc: null,
    destLoc: destLat && destLon ? { lat: destLat, lon: destLon } : null,
    mode,
    createdAt: Date.now(),
    expiresAt: Date.now() + DURATIONS[duration],
    subscription: null,
    notified: false,
  };
  res.json({ code });
});

app.post('/api/location/:code', async (req, res) => {
  const session = sessions[req.params.code];
  if (!session) return res.status(404).json({ error: 'Oturum bulunamadı' });
  if (Date.now() > session.expiresAt) return res.status(410).json({ error: 'Süre doldu' });

  const { lat, lon } = req.body;
  session.travelerLoc = { lat, lon, updatedAt: Date.now() };

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
    mode: session.mode,
    expiresAt: session.expiresAt,
  });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY || null });
});

async function maybeNotify(session) {
  if (session.notified) return;
  if (!session.travelerLoc || !session.destLoc || !session.subscription) return;
  if (session.routeEtaMinutes == null) return;

  const etaMinutes = session.routeEtaMinutes;

  if (etaMinutes <= 1) {
    session.notified = true;
    const payload = JSON.stringify({
      title: 'Neredeyse geldi!',
      body: '1 dakika sonra yanınızda olacak.',
    });
    webpush.sendNotification(session.subscription, payload).catch((err) => {
      console.error('Push gönderim hatası:', err.message);
    });
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
