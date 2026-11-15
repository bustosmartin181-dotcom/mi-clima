// Service worker mínimo de Mi Clima: solo sirve para mostrar las notificaciones de la alarma en Android.
// No guarda nada en caché ni intercepta pedidos.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(ventanas => {
      for (const v of ventanas) {
        if ("focus" in v) return v.focus();
      }
      return self.clients.openWindow("./");
    })
  );
});
