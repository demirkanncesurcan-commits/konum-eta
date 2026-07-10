self.addEventListener('push', (event) => {
  let data = { title: 'Yaklaşıyor', body: '1 dakika sonra yanınızda olacak.' };
  try { data = event.data.json(); } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.png',
      vibrate: [200, 100, 200, 100, 200],
      tag: 'konum-eta'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
