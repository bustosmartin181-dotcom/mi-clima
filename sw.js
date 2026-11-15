// Service worker de Mi Clima: muestra las notificaciones de la alarma y los avisos con la pantalla apagada.
// No guarda nada en caché ni intercepta pedidos.
const PROXY = "https://mi-clima-proxy.bustosmartin181.workers.dev";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

async function idDe(endpoint) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return Array.from(h.slice(0, 16), b => b.toString(16).padStart(2, "0")).join("");
}

// Llega un aviso del intermediario (sin texto): se pide el texto y se muestra la notificación
self.addEventListener("push", e => {
  e.waitUntil((async () => {
    let titulo = "⚠ Mi Clima: atención", cuerpo = "Puede haber una tormenta cerca. Abrí la app para ver el radar.";
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) {
        const r = await fetch(PROXY + "/aviso?id=" + await idDe(sub.endpoint), { cache: "no-store" });
        if (r.ok) {
          const d = await r.json();
          if (d.titulo) { titulo = d.titulo; cuerpo = d.cuerpo || cuerpo; }
        }
      }
    } catch (err) { /* sin conexión: se muestra el aviso genérico */ }
    await self.registration.showNotification(titulo, {
      body: cuerpo, icon: "icono-192.png", badge: "icono-192.png", tag: "mi-clima-aviso",
      renotify: true, requireInteraction: true, vibrate: [400, 150, 400, 150, 400]
    });
  })());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(ventanas => {
      for (const v of ventanas) if ("focus" in v) return v.focus();
      return self.clients.openWindow("./");
    })
  );
});
