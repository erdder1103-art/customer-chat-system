self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: '客服訊息通知', body: event.data ? event.data.text() : '你有新訊息通知' };
  }

  const title = data.title || '客服訊息通知';
  const options = {
    body: data.body || '你有新訊息通知',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    data: {
      url: data.url || '/',
      conversation_id: data.conversation_id || ''
    },
    tag: data.conversation_id ? 'ccs-' + data.conversation_id : 'ccs-message',
    renotify: true
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const targetUrl = event.notification && event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : '/';

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });

    for (const client of allClients) {
      if (client.url === targetUrl && 'focus' in client) {
        return client.focus();
      }
    }

    if (clients.openWindow) {
      return clients.openWindow(targetUrl);
    }
  })());
});
