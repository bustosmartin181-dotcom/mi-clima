// Mi Clima - intermediario (Cloudflare Worker) - versión 6
// 1) Deja que la app lea del sitio de Contingencias Climáticas de Mendoza:
//      /rayos                              -> rayos del satélite (solo zona Mendoza)
//      /radar/AAAAMMDD/HHMMSS_dbz.png      -> imagen del radar
//      /radar/AAAAMMDD/HHMMSS_granizo.png  -> probabilidad de granizo
// 2) Avisos con la pantalla apagada: cada 5 minutos (Cron Trigger) revisa el radar y los rayos
//    en la última ubicación de cada celular suscripto y, si hay peligro, le manda una notificación.
//    Necesita un espacio KV conectado con el nombre MI_CLIMA. No usa claves que tengas que copiar:
//    las genera solo la primera vez y las guarda en ese KV.
// 3) Hasta 10 celulares. Opcional: si cargás un secreto llamado CODIGO, solo se pueden anotar
//    los celulares que escriban ese código de invitación.
// 4) (versión 4) Avisos oficiales del SMN y reportes de lo que cae:
//      /smn                 -> lista de avisos del SMN (feed CAP oficial)
//      /smn?u=<enlace>      -> detalle de un aviso (solo enlaces de ssl.smn.gob.ar/feeds/)
//      GET  /reportes       -> reportes de los usuarios de las últimas 3 horas
//      POST /reportes       -> guarda un reporte {lat, lon, tipo, tam} (usa el KV MI_CLIMA)
// 5) (versión 5) Radares nacionales SINARAME (información oficial, radares.hidricosargentina.gob.ar):
//      /sinarame/RMA19/AAAAMMDDHHMM00.png -> imagen de un radar (hora argentina, una cada 10 minutos)
//    Cada imagen se guarda un día en la caché de Cloudflare, para no pedirle de más al servidor oficial.

const ORIGEN = "https://www2.contingencias.mendoza.gov.ar";
const APP = "https://bustosmartin181-dotcom.github.io/mi-clima/";
const PAGINAS_PERMITIDAS = ["https://bustosmartin181-dotcom.github.io"];
const ZONA = { sur: -37.5, norte: -28.5, oeste: -72.0, este: -64.0 };
const RUTA_RADAR = /^\/radar\/(\d{8})\/(\d{6})_(dbz|granizo)\.png$/;
const SERVICIOS_PUSH = [
  /^https:\/\/fcm\.googleapis\.com\//,
  /^https:\/\/updates\.push\.services\.mozilla\.com\//,
  /^https:\/\/[a-z0-9.-]+\.notify\.windows\.com\//,
  /^https:\/\/web\.push\.apple\.com\//
];
const MAX_SUSCRIPCIONES = 10;
const POR_REVISION = 3; // celulares de la zona del radar que se revisan en cada pasada (se van turnando, agrupados por cercanía)
const PASO_MS = 2 * 60 * 1000;

// ---------- Geometría del radar (igual que en la app) ----------
const ANCHO = 500, ALTO = 700;
// Corrimiento de la imagen de Contingencias (igual que en la app): dibuja la lluvia ~17 km al este y ~2 km al norte
const CORR_LAT = 2 / 110.574, CORR_LON = 17 / (111.32 * Math.cos(-33 * Math.PI / 180));
const B_SUR = -34.0 - 250 / 110.924 + 0.046 - CORR_LAT, B_NORTE = -34.0 + 450 / 110.924 + 0.046 - CORR_LAT;
const B_OESTE = -68.0 - 250 / 92.425 - CORR_LON, B_ESTE = -68.0 + 250 / 92.425 - CORR_LON;
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const Y_N = mercY(B_NORTE), Y_S = mercY(B_SUR);
const LON_COL = new Float64Array(ANCHO), LAT_FILA = new Float64Array(ALTO);
for (let x = 0; x < ANCHO; x++) LON_COL[x] = B_OESTE + (x + 0.5) / ANCHO * (B_ESTE - B_OESTE);
for (let y = 0; y < ALTO; y++) LAT_FILA[y] = (2 * Math.atan(Math.exp(Y_N - (y + 0.5) / ALTO * (Y_N - Y_S))) - Math.PI / 2) * 180 / Math.PI;
function aPixel(lat, lon) {
  return { x: (lon - B_OESTE) / (B_ESTE - B_OESTE) * ANCHO - 0.5, y: (Y_N - mercY(lat)) / (Y_N - Y_S) * ALTO - 0.5 };
}
function kmEntre(lat1, lon1, lat2, lon2) {
  const x = (lon2 - lon1) * Math.cos((lat1 + lat2) * Math.PI / 360) * 111.32;
  const y = (lat2 - lat1) * 110.574;
  return Math.hypot(x, y);
}
const rgb = (r, g, b) => (r << 16) | (g << 8) | b;
const DBZ_POR_COLOR = new Map([
  [rgb(211, 211, 211), 70], [rgb(128, 128, 128), 65], [rgb(253, 52, 28), 60], [rgb(254, 95, 5), 57],
  [rgb(254, 154, 88), 54], [rgb(254, 250, 3), 51], [rgb(250, 196, 49), 48], [rgb(210, 136, 59), 45],
  [rgb(192, 100, 135), 42], [rgb(200, 15, 134), 39], [rgb(110, 13, 198), 36], [rgb(28, 71, 232), 35],
  [rgb(8, 127, 219), 30], [rgb(0, 112, 0), 20], [rgb(0, 90, 0), 10], [rgb(72, 61, 139), 5]
]);

// ---------- Utilidades ----------
function encabezadosCors(request, env) {
  const extra = env && env.PAGINAS_EXTRA ? String(env.PAGINAS_EXTRA).split(",").map(s => s.trim()).filter(Boolean) : [];
  const origen = request.headers.get("Origin");
  const h = { "Vary": "Origin" };
  if (origen && PAGINAS_PERMITIDAS.concat(extra).includes(origen)) {
    h["Access-Control-Allow-Origin"] = origen;
    h["Access-Control-Allow-Methods"] = "GET, HEAD, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}
function texto(mensaje, estado, cors, extra) {
  return new Response(mensaje, { status: estado, headers: Object.assign({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, cors, extra || {}) });
}
function json(obj, estado, cors) {
  return new Response(JSON.stringify(obj), { status: estado, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, cors) });
}
function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function idDe(endpoint) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return Array.from(h.slice(0, 16), b => b.toString(16).padStart(2, "0")).join("");
}
function pad(n) { return String(n).padStart(2, "0"); }
function urlRadar(t, tipo) {
  const d = new Date(t);
  return `${ORIGEN}/radar/web/${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}/${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00_${tipo}.png`;
}

// ---------- Rayos e imágenes ----------
async function leerRayos() {
  const r = await fetch(ORIGEN + "/rayos/rayos.json", { cf: { cacheTtl: 10, cacheEverything: true } });
  if (!r.ok) throw new Error("Contingencias respondió " + r.status);
  const datos = await r.json();
  const enZona = [];
  for (const x of Array.isArray(datos) ? datos : []) {
    const lat = Number(x.lat), lon = Number(x.lng !== undefined ? x.lng : x.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < ZONA.sur || lat > ZONA.norte || lon < ZONA.oeste || lon > ZONA.este) continue;
    enZona.push({ id: String(x.id), lat, lon, e: Number(x.e) || 0, hora: String(x.fecha || "") });
  }
  return enZona;
}

async function rayos(cors) {
  try {
    return new Response(JSON.stringify({ generado: new Date().toISOString(), rayos: await leerRayos() }), {
      status: 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=10" }, cors)
    });
  } catch (e) {
    return texto("No pude leer los rayos: " + e.message, 502, cors);
  }
}

async function imagenRadar(m, cors) {
  let r;
  try {
    r = await fetch(`${ORIGEN}/radar/web/${m[1]}/${m[2]}_${m[3]}.png`, { cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 86400, "404": 20, "500-599": 0 } } });
  } catch (e) {
    return texto("Sin conexión con Contingencias", 502, cors);
  }
  if (r.status === 404) return texto("Esa imagen no existe (todavía)", 404, cors, { "Cache-Control": "public, max-age=20" });
  if (!r.ok) return texto("Contingencias respondió " + r.status, 502, cors);
  if (!(r.headers.get("Content-Type") || "").startsWith("image/png")) return texto("Respuesta inesperada de Contingencias", 502, cors);
  return new Response(r.body, { status: 200, headers: Object.assign({ "Content-Type": "image/png", "Cache-Control": "public, max-age=86400, immutable" }, cors) });
}

// Busca la imagen más nueva del radar (se publica una cada 2 minutos)
async function ultimaImagen() {
  const ultimoPar = Math.floor(Date.now() / PASO_MS) * PASO_MS;
  for (let k = 0; k < 8; k++) {
    const t = ultimoPar - k * PASO_MS;
    const r = await fetch(urlRadar(t, "dbz"), { cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 86400, "404": 20 } } });
    if (r.ok) return { t, bytes: new Uint8Array(await r.arrayBuffer()) };
    if (r.body) await r.body.cancel();
  }
  return null;
}

// Techo de ruido de cada punto (lo que el radar marca ahí sin lluvia). Se guarda en memoria.
let ruidoEnMemoria = null;
async function techoDeRuido() {
  if (ruidoEnMemoria) return ruidoEnMemoria;
  const r = await fetch(APP + "ruido.bin", { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!r.ok) return null;
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length !== ANCHO * ALTO) return null;
  ruidoEnMemoria = b;
  return b;
}

// Lee solo la franja del PNG (RGBA, 8 bits) que hace falta, para gastar poco cálculo.
// Devuelve las filas desde "inicio" hasta filaHasta, y las columnas 0..colHasta.
async function leerFranja(bytes, filaDesde, filaHasta, colHasta) {
  const u32 = p => ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
  let p = 8, w = 0, h = 0, ok = false;
  const partes = [];
  while (p + 8 <= bytes.length) {
    const largo = u32(p);
    const tipo = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    if (tipo === "IHDR") {
      w = u32(p + 8); h = u32(p + 12);
      ok = bytes[p + 16] === 8 && bytes[p + 17] === 6 && bytes[p + 20] === 0;
    } else if (tipo === "IDAT") {
      partes.push(bytes.subarray(p + 8, p + 8 + largo));
    } else if (tipo === "IEND") break;
    p += 12 + largo;
  }
  if (!ok || w !== ANCHO || h !== ALTO) throw new Error("formato de imagen inesperado");
  const paso = w * 4, filas = Math.min(h, filaHasta + 1);
  const primera = Math.max(0, filaDesde - 40); // margen para encontrar una fila "independiente"
  const desdeByte = primera * (paso + 1), hastaByte = filas * (paso + 1);
  const crudo = new Uint8Array(hastaByte - desdeByte);
  const ds = new DecompressionStream("deflate");
  const escritor = ds.writable.getWriter();
  (async () => { try { for (const c of partes) await escritor.write(c); await escritor.close(); } catch (e) { /* cortado a propósito */ } })();
  const lector = ds.readable.getReader();
  let pos = 0;
  while (pos < hastaByte) {
    const { value, done } = await lector.read();
    if (done) break;
    const a = Math.max(pos, desdeByte), b = Math.min(pos + value.length, hastaByte);
    if (b > a) crudo.set(value.subarray(a - pos, b - pos), a - desdeByte);
    pos += value.length;
  }
  lector.cancel().catch(() => {});
  // Los filtros 0 y 1 no dependen de la fila de arriba: arrancamos desde la última fila así
  let inicio = Math.min(filaDesde, filas - 1);
  while (inicio > primera && crudo[(inicio - primera) * (paso + 1)] > 1) inicio--;
  if (inicio > 0 && crudo[(inicio - primera) * (paso + 1)] > 1) throw new Error("no encontré una fila independiente");
  const ancho = Math.min(paso, (colHasta + 1) * 4), n = filas - inicio;
  const px = new Uint8Array(n * ancho);
  for (let yy = 0; yy < n; yy++) {
    const base = (yy + inicio - primera) * (paso + 1), f = crudo[base], s = base + 1, d = yy * ancho, a = d - ancho, arriba = yy > 0;
    if (f === 0) {
      px.set(crudo.subarray(s, s + ancho), d);
    } else if (f === 1) {
      for (let i = 0; i < ancho; i++) px[d + i] = (crudo[s + i] + (i >= 4 ? px[d + i - 4] : 0)) & 255;
    } else if (f === 2) {
      if (arriba) for (let i = 0; i < ancho; i++) px[d + i] = (crudo[s + i] + px[a + i]) & 255;
      else px.set(crudo.subarray(s, s + ancho), d);
    } else if (f === 3) {
      for (let i = 0; i < ancho; i++) px[d + i] = (crudo[s + i] + (((i >= 4 ? px[d + i - 4] : 0) + (arriba ? px[a + i] : 0)) >> 1)) & 255;
    } else if (f === 4) {
      for (let i = 0; i < ancho; i++) {
        const izq = i >= 4 ? px[d + i - 4] : 0, arr = arriba ? px[a + i] : 0, ai = arriba && i >= 4 ? px[a + i - 4] : 0;
        const pp = izq + arr - ai, pa = Math.abs(pp - izq), pb = Math.abs(pp - arr), pc = Math.abs(pp - ai);
        px[d + i] = (crudo[s + i] + (pa <= pb && pa <= pc ? izq : pb <= pc ? arr : ai)) & 255;
      }
    }
  }
  return { inicio, filas, ancho, px };
}

// ---------- Análisis en la zona de una ubicación ----------
const RADIO_PX = 40; // ~40 km alrededor

// Recorre los grupos de puntos vecinos con valor >= umbral y avisa el tamaño y el máximo de cada uno
function recorrerGrupos(g, W, H, umbral, visto, pila, comp, alTerminar) {
  visto.fill(0);
  for (let i = 0; i < g.length; i++) {
    if (visto[i] || g[i] < umbral) continue;
    let tope = 0, n = 0, max = 0;
    pila[tope++] = i; visto[i] = 1;
    while (tope) {
      const k = pila[--tope];
      comp[n++] = k;
      if (g[k] > max) max = g[k];
      const x = k % W, y = (k - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const j = ny * W + nx;
          if (!visto[j] && g[j] >= umbral) { visto[j] = 1; pila[tope++] = j; }
        }
      }
    }
    alTerminar(n, max);
  }
}

function analizar(img, ruido, lat, lon) {
  const c = aPixel(lat, lon);
  if (c.x < 0 || c.y < 0 || c.x > ANCHO - 1 || c.y > ALTO - 1) return null;
  const x0 = Math.max(0, Math.floor(c.x - RADIO_PX)), x1 = Math.min(ANCHO - 1, Math.ceil(c.x + RADIO_PX));
  const y0 = Math.max(img.inicio, Math.floor(c.y - RADIO_PX)), y1 = Math.min(img.filas - 1, Math.ceil(c.y + RADIO_PX));
  if (y1 < y0 || (x1 + 1) * 4 > img.ancho) return null;
  const W = x1 - x0 + 1, H = y1 - y0 + 1, g = new Uint8Array(W * H), px = img.px;
  for (let y = y0; y <= y1; y++) {
    const fila = (y - img.inicio) * img.ancho, filaR = y * ANCHO, filaG = (y - y0) * W - x0;
    for (let x = x0; x <= x1; x++) {
      const q = fila + x * 4;
      if (px[q + 3] < 128) continue;
      const v = DBZ_POR_COLOR.get((px[q] << 16) | (px[q + 1] << 8) | px[q + 2]);
      if (v && (!ruido || v > ruido[filaR + x])) g[filaG + x] = v;
    }
  }
  // Distancias en km desde tu ubicación (por columna y por fila)
  const cosLat = Math.cos(lat * Math.PI / 180), DX = new Float64Array(W), DY = new Float64Array(H);
  for (let i = 0; i < W; i++) DX[i] = (LON_COL[x0 + i] - lon) * cosLat * 111.32;
  for (let j = 0; j < H; j++) DY[j] = (LAT_FILA[y0 + j] - lat) * 110.574;
  const d2 = k => { const x = k % W, y = (k - x) / W; return DX[x] * DX[x] + DY[y] * DY[y]; };
  const visto = new Uint8Array(W * H), pila = new Int32Array(W * H), comp = new Int32Array(W * H);
  // Una tormenta real ocupa varios km² juntos: se borran los grupos de menos de 6 puntos
  recorrerGrupos(g, W, H, 1, visto, pila, comp, (n) => { if (n < 6) for (let k = 0; k < n; k++) g[comp[k]] = 0; });
  let encima = 0;
  for (let k = 0; k < g.length; k++) if (g[k] > encima && d2(k) <= 9) encima = g[k];
  const masCercano = (umbral, minPx) => {
    let mejor = Infinity, maxDbz = 0;
    recorrerGrupos(g, W, H, umbral, visto, pila, comp, (n, max) => {
      if (n < minPx) return;
      for (let k = 0; k < n; k++) { const d = d2(comp[k]); if (d < mejor) { mejor = d; maxDbz = max; } }
    });
    return { km: Math.sqrt(mejor), maxDbz };
  };
  const nucleo = masCercano(35, 6), lluvia = masCercano(20, 10);
  return { encima, dNucleo: nucleo.km, maxNucleo: nucleo.maxDbz, dLluvia: lluvia.km };
}

// "HH:MM:SS" (UTC, sin fecha) -> milisegundos
function horaUtcAMs(hhmmss, baseDia, ahora) {
  if (typeof hhmmss !== "string" || hhmmss.length !== 8) return null;
  const n = i => hhmmss.charCodeAt(i) - 48;
  const h = n(0) * 10 + n(1), m = n(3) * 10 + n(4), s = n(6) * 10 + n(7);
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60 && s >= 0 && s < 60)) return null;
  let t = baseDia + ((h * 60 + m) * 60 + s) * 1000;
  if (t > ahora + 5 * 60000) t -= 86400000;
  return t;
}

const ORDEN = { gris: 0, verde: 1, amarillo: 2, naranja: 3, rojo: 4 };
const km = d => d < 10 ? d.toFixed(1).replace(".", ",") : String(Math.round(d));

function decidir(a, rayosLista, lat, lon, anterior, tRadar) {
  const ahora = Date.now(), hoy = new Date(ahora);
  const baseDia = Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate());
  let rayo = null;
  for (const r of rayosLista) {
    const t = horaUtcAMs(r.hora, baseDia, ahora);
    if (t === null || ahora - t > 10 * 60000) continue;
    const d = kmEntre(lat, lon, r.lat, r.lon);
    if (!rayo || d < rayo.km) rayo = { km: d };
  }
  const dN = a ? a.dNucleo : Infinity;
  // Velocidad de acercamiento: se descarta si es imposible (más de 100 km/h, señal de que se compararon dos tormentas
  // distintas) y solo se usa si se repite parecida en dos revisiones seguidas
  let eta = null, vAcerca = null;
  if (a && Number.isFinite(dN) && anterior && Number.isFinite(anterior.dNucleo) && anterior.tRadar && tRadar > anterior.tRadar) {
    const v = (anterior.dNucleo - dN) / ((tRadar - anterior.tRadar) / 3600000);
    if (v >= 5 && v <= 100) {
      vAcerca = v;
      const vAnt = anterior.vAcerca;
      if (typeof vAnt === "number" && vAnt >= 5 && v <= vAnt * 2 && vAnt <= v * 2 && dN > 3) eta = dN / ((v + vAnt) / 2) * 60;
    }
  } else if (anterior && tRadar === anterior.tRadar) vAcerca = anterior.vAcerca;
  let nivel = "verde", titulo = "Sin tormentas cerca";
  if (a && a.encima >= 40) { nivel = "rojo"; titulo = "Tormenta fuerte encima tuyo"; }
  else if (rayo && rayo.km <= 8) { nivel = "rojo"; titulo = `Rayos a ${km(rayo.km)} km`; }
  else if (dN <= 15) { nivel = "naranja"; titulo = `Tormenta cerca: a ${km(dN)} km`; }
  else if (eta !== null && eta <= 30 && dN <= 40) { nivel = "naranja"; titulo = `Tormenta acercándose: llegaría en ~${Math.round(eta)} min`; }
  else if (rayo && rayo.km <= 20) { nivel = "naranja"; titulo = `Rayos cerca: a ${km(rayo.km)} km`; }
  else if (a && a.encima >= 20) { nivel = "naranja"; titulo = "Está lloviendo en tu zona"; }
  else if (dN <= 40 || (a && a.dLluvia <= 15) || (rayo && rayo.km <= 40)) { nivel = "amarillo"; titulo = "Tormentas en la zona"; }
  const partes = [];
  if (Number.isFinite(dN)) partes.push(`Tormenta más cercana a ${km(dN)} km (${a.maxNucleo} dBZ)` + (eta !== null ? `, llegaría en ~${Math.round(eta)} min` : ""));
  if (rayo) partes.push(`rayo más cercano a ${km(rayo.km)} km`);
  if (!a) partes.push("sin datos del radar en tu zona");
  return { nivel, titulo, cuerpo: partes.length ? partes.join(" · ") + "." : "Abrí la app para ver el radar.", dNucleo: dN, tRadar, vAcerca };
}

// ---------- Avisos (Web Push sin contenido: el celular pide el texto después) ----------
async function clavesVapid(env) {
  let c = await env.MI_CLIMA.get("vapid", "json");
  if (!c) {
    const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privada = await crypto.subtle.exportKey("jwk", par.privateKey);
    const publica = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", par.publicKey)));
    await env.MI_CLIMA.put("vapid", JSON.stringify({ privada, publica }));
    c = await env.MI_CLIMA.get("vapid", "json"); // por si dos pedidos las crearon a la vez
  }
  return c;
}

async function enviarAviso(env, endpoint) {
  const c = await clavesVapid(env);
  const clave = await crypto.subtle.importKey("jwk", c.privada, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const enc = new TextEncoder();
  const cab = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const dat = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: APP })));
  const firma = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, clave, enc.encode(cab + "." + dat)));
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "TTL": "900", "Urgency": "high", "Authorization": `vapid t=${cab}.${dat}.${b64url(firma)}, k=${c.publica}` },
    body: new Uint8Array(0)
  });
  return r.status;
}

async function leerSuscripciones(env) {
  return (await env.MI_CLIMA.get("suscripciones", "json")) || [];
}
async function guardarSuscripciones(env, lista) {
  await env.MI_CLIMA.put("suscripciones", JSON.stringify(lista));
}

function ubicacionValida(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -60 && lat <= 0 && lon >= -80 && lon <= -50;
}

async function suscribir(request, env, cors) {
  let d;
  try { d = await request.json(); } catch (e) { return texto("Pedido inválido", 400, cors); }
  const endpoint = d && d.endpoint;
  if (typeof endpoint !== "string" || !SERVICIOS_PUSH.some(re => re.test(endpoint))) return texto("Servicio de avisos no reconocido", 400, cors);
  const lat = Number(d.lat), lon = Number(d.lon);
  if (!ubicacionValida(lat, lon)) return texto("Ubicación inválida", 400, cors);
  const id = await idDe(endpoint);
  const lista = await leerSuscripciones(env);
  const existente = lista.find(s => s.id === id);
  if (env.CODIGO && !existente && String(d.codigo || "").trim() !== String(env.CODIGO).trim()) return texto("Código de invitación incorrecto", 403, cors);
  if (!existente && lista.length >= MAX_SUSCRIPCIONES) return texto(`La lista de avisos está completa (${MAX_SUSCRIPCIONES} celulares)`, 409, cors);
  if (existente) { existente.lat = lat; existente.lon = lon; existente.actualizado = Date.now(); }
  else lista.push({ id, endpoint, lat, lon, actualizado: Date.now() });
  await guardarSuscripciones(env, lista);
  return json({ ok: true, id }, 200, cors);
}

async function ubicacion(request, env, cors) {
  let d;
  try { d = await request.json(); } catch (e) { return texto("Pedido inválido", 400, cors); }
  const lat = Number(d && d.lat), lon = Number(d && d.lon);
  if (!ubicacionValida(lat, lon) || typeof (d && d.endpoint) !== "string") return texto("Pedido inválido", 400, cors);
  const id = await idDe(d.endpoint);
  const lista = await leerSuscripciones(env);
  const s = lista.find(x => x.id === id);
  if (!s) return texto("Ese celular no está suscripto", 404, cors);
  s.lat = lat; s.lon = lon; s.actualizado = Date.now();
  await guardarSuscripciones(env, lista);
  return json({ ok: true }, 200, cors);
}

async function desuscribir(request, env, cors) {
  let d;
  try { d = await request.json(); } catch (e) { return texto("Pedido inválido", 400, cors); }
  if (typeof (d && d.endpoint) !== "string") return texto("Pedido inválido", 400, cors);
  const id = await idDe(d.endpoint);
  await guardarSuscripciones(env, (await leerSuscripciones(env)).filter(s => s.id !== id));
  const estados = (await env.MI_CLIMA.get("estados", "json")) || {};
  if (estados[id]) { delete estados[id]; await env.MI_CLIMA.put("estados", JSON.stringify(estados)); }
  await env.MI_CLIMA.delete("estado:" + id); // limpieza de la versión anterior
  return json({ ok: true }, 200, cors);
}

async function probar(request, env, cors) {
  let d;
  try { d = await request.json(); } catch (e) { return texto("Pedido inválido", 400, cors); }
  const id = await idDe(String(d && d.endpoint || ""));
  const s = (await leerSuscripciones(env)).find(x => x.id === id);
  if (!s) return texto("Ese celular no está suscripto", 404, cors);
  await env.MI_CLIMA.put("aviso:" + id, JSON.stringify({ titulo: "✅ Prueba de Mi Clima", cuerpo: "Los avisos con la pantalla apagada funcionan.", t: Date.now() }), { expirationTtl: 3600 });
  const estado = await enviarAviso(env, s.endpoint);
  return json({ ok: estado >= 200 && estado < 300, estado }, 200, cors);
}

async function avisoGuardado(url, env, cors) {
  const id = url.searchParams.get("id") || "";
  if (!/^[0-9a-f]{32}$/.test(id)) return texto("Pedido inválido", 400, cors);
  const a = await env.MI_CLIMA.get("aviso:" + id, "json");
  return json(a && Date.now() - a.t < 60 * 60000 ? { titulo: a.titulo, cuerpo: a.cuerpo } : {}, 200, cors);
}

async function estadoGuardado(url, env, cors) {
  const id = url.searchParams.get("id") || "";
  if (!/^[0-9a-f]{32}$/.test(id)) return texto("Pedido inválido", 400, cors);
  const estados = (await env.MI_CLIMA.get("estados", "json")) || {};
  return json(estados[id] || {}, 200, cors);
}

// Revisión automática (Cron Trigger, cada 5 minutos)
// Para cuidar los límites gratis de Cloudflare: todos los estados van en una sola clave ("estados"),
// se guarda solo si algo cambió (o cada 15 minutos), y si hay muchos celulares en la zona del radar
// se revisan de a POR_REVISION por pasada, turnándose.
function dentroDelRadar(lat, lon) {
  const c = aPixel(lat, lon);
  return c.x >= 0 && c.y >= 0 && c.x <= ANCHO - 1 && c.y <= ALTO - 1;
}

async function revisar(env, momento, intervaloMin) {
  const lista = await leerSuscripciones(env);
  if (!lista.length) return { suscripciones: 0 };
  const ahora = Date.now();
  momento = momento || ahora;
  intervaloMin = intervaloMin || 5;
  const estados = (await env.MI_CLIMA.get("estados", "json")) || {};
  let cambio = false;
  // ordenados de norte a sur: cada grupo queda con celulares cercanos y se lee una franja chica del radar
  const enZona = lista.filter(s => dentroDelRadar(s.lat, s.lon)).sort((a, b) => aPixel(a.lat, a.lon).y - aPixel(b.lat, b.lon).y || (a.id < b.id ? -1 : 1));
  for (const s of lista) {
    if (!dentroDelRadar(s.lat, s.lon) && (!estados[s.id] || estados[s.id].nivel !== "gris")) {
      estados[s.id] = { nivel: "gris", titulo: "Fuera del área del radar de Mendoza", cuerpo: "Los avisos con pantalla apagada funcionan en la zona del radar de Mendoza.", revisado: ahora };
      cambio = true;
    }
  }
  // Grupos de celulares cercanos (hasta POR_REVISION, a menos de ~40 km de norte a sur entre sí)
  const grupos = [];
  let actual = [], yMin = Infinity, yMax = -Infinity;
  for (const s of enZona) {
    const y = aPixel(s.lat, s.lon).y;
    if (actual.length && (actual.length >= POR_REVISION || Math.max(yMax, y) - Math.min(yMin, y) > 40)) { grupos.push(actual); actual = []; yMin = Infinity; yMax = -Infinity; }
    actual.push(s); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
  }
  if (actual.length) grupos.push(actual);
  const lote = grupos.length ? grupos[Math.round(momento / (intervaloMin * 60000)) % grupos.length] : []; // cada pasada le toca al grupo siguiente
  if (lote.length) {
    const [rayosLista, imagen, ruido] = await Promise.all([leerRayos().catch(() => []), ultimaImagen().catch(() => null), techoDeRuido().catch(() => null)]);
    let img = null;
    if (imagen) {
      let filaDesde = ALTO, filaHasta = 0, colHasta = 0;
      for (const s of lote) {
        const c = aPixel(s.lat, s.lon);
        filaDesde = Math.min(filaDesde, Math.floor(c.y) - RADIO_PX);
        filaHasta = Math.max(filaHasta, Math.ceil(c.y) + RADIO_PX);
        colHasta = Math.max(colHasta, Math.ceil(c.x) + RADIO_PX);
      }
      filaDesde = Math.max(0, filaDesde); filaHasta = Math.min(ALTO - 1, filaHasta); colHasta = Math.min(ANCHO - 1, Math.max(0, colHasta));
      if (filaDesde <= filaHasta) {
        try { img = await leerFranja(imagen.bytes, filaDesde, filaHasta, colHasta); } catch (e) { img = null; }
      }
    }
    const borrar = [];
    for (const s of lote) {
      const anterior = estados[s.id] || {};
      const a = img ? analizar(img, ruido, s.lat, s.lon) : null;
      const r = decidir(a, rayosLista, s.lat, s.lon, anterior, imagen ? imagen.t : 0);
      r.ultimoAviso = anterior.ultimoAviso || 0;
      const subio = ORDEN[r.nivel] > ORDEN[anterior.nivel || "verde"];
      const repetir = ORDEN[r.nivel] >= ORDEN.naranja && ahora - r.ultimoAviso > 60 * 60000;
      if (ORDEN[r.nivel] >= ORDEN.naranja && (subio || repetir)) {
        await env.MI_CLIMA.put("aviso:" + s.id, JSON.stringify({ titulo: "⚠ " + r.titulo, cuerpo: r.cuerpo, t: ahora }), { expirationTtl: 3600 });
        const estado = await enviarAviso(env, s.endpoint);
        if (estado === 404 || estado === 410) borrar.push(s.id);
        r.ultimoAviso = ahora;
        r.ultimoEnvio = estado;
      }
      const dA = Number.isFinite(anterior.dNucleo) ? anterior.dNucleo : null, dN = Number.isFinite(r.dNucleo) ? r.dNucleo : null;
      const movio = (dA === null) !== (dN === null) || (dN !== null && dN < 80 && Math.abs(dN - dA) >= 3);
      const viejo = ahora - (anterior.revisado || 0) >= 15 * 60000;
      if (r.nivel !== anterior.nivel || r.titulo !== anterior.titulo || movio || r.ultimoAviso !== (anterior.ultimoAviso || 0) || viejo) {
        r.revisado = ahora;
        estados[s.id] = r;
        cambio = true;
      }
    }
    if (borrar.length) {
      await guardarSuscripciones(env, lista.filter(s => !borrar.includes(s.id)));
      for (const id of borrar) delete estados[id];
      cambio = true;
    }
  }
  // quitar estados de celulares que ya no están en la lista
  for (const id of Object.keys(estados)) if (!lista.some(s => s.id === id)) { delete estados[id]; cambio = true; }
  if (cambio) await env.MI_CLIMA.put("estados", JSON.stringify(estados));
  return { suscripciones: lista.length, revisados: lote.length, guardo: cambio };
}

// ---------- Avisos oficiales del SMN (feed CAP) ----------
const SMN_FEED = "https://ssl.smn.gob.ar/CAP/AR.php";
const SMN_DETALLE = /^https:\/\/ssl\.smn\.gob\.ar\/feeds\/[A-Za-z0-9_\/.-]+\.xml$/;
async function smn(url, cors) {
  const u = url.searchParams.get("u");
  const destino = u ? u : SMN_FEED;
  if (u && !SMN_DETALLE.test(u)) return texto("Enlace no permitido", 400, cors);
  try {
    const r = await fetch(destino, { headers: { "User-Agent": "MiClima/4 (uso personal)" }, cf: { cacheTtl: u ? 3600 : 300, cacheEverything: true } });
    if (!r.ok) return texto("El SMN respondió " + r.status, 502, cors);
    return new Response(await r.text(), { status: 200, headers: Object.assign({ "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=" + (u ? 3600 : 300) }, cors) });
  } catch (e) {
    return texto("No pude leer el SMN: " + e.message, 502, cors);
  }
}

// ---------- Radares nacionales SINARAME ----------
const SINARAME = "https://radares.hidricosargentina.gob.ar/cache/";
const RUTA_SINARAME = /^\/sinarame\/(RMA\d{1,2})\/(\d{14})\.png$/;
async function imagenSinarame(m, cors) {
  try {
    const r = await fetch(`${SINARAME}${m[1]}/${m[2]}.png`, {
      headers: { "User-Agent": "MiClima/5 (uso personal)" },
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 86400, "404": 120, "500-599": 0 } }
    });
    if (!r.ok) return texto("Sin imagen", r.status === 404 ? 404 : 502, cors);
    return new Response(r.body, { status: 200, headers: Object.assign({ "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" }, cors) });
  } catch (e) {
    return texto("No pude leer SINARAME: " + e.message, 502, cors);
  }
}

// ---------- Reportes de los usuarios (qué está cayendo) ----------
const REPORTE_VIDA_MS = 3 * 3600000;
const REPORTE_TIPOS = ["nada", "llovizna", "lluvia", "lluviaFuerte", "granizo", "viento", "nieve"];
const REPORTE_TAMS = ["", "arveja", "garbanzo", "nuez", "huevo"];
async function leerReportes(env) {
  const lista = JSON.parse((await env.MI_CLIMA.get("reportes")) || "[]");
  const ahora = Date.now();
  return lista.filter(r => ahora - r.t < REPORTE_VIDA_MS);
}
async function reportes(request, env, cors) {
  if (request.method === "GET") {
    const lista = await leerReportes(env);
    return json({ reportes: lista.map(({ ip, ...r }) => r) }, 200, cors);
  }
  let b;
  try { b = await request.json(); } catch (e) { return texto("Pedido inválido", 400, cors); }
  const lat = Number(b.lat), lon = Number(b.lon);
  if (!isFinite(lat) || !isFinite(lon) || lat < ZONA.sur - 3 || lat > ZONA.norte + 3 || lon < ZONA.oeste - 3 || lon > ZONA.este + 3) return texto("Ubicación fuera de la zona", 400, cors);
  if (!REPORTE_TIPOS.includes(b.tipo)) return texto("Tipo inválido", 400, cors);
  const tam = REPORTE_TAMS.includes(b.tam) ? b.tam : "";
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const lista = await leerReportes(env);
  if (lista.some(r => r.ip === ip && Date.now() - r.t < 2 * 60000)) return texto("Esperá un par de minutos para mandar otro reporte", 429, cors);
  const nuevo = { id: crypto.randomUUID().slice(0, 8), t: Date.now(), lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, tipo: b.tipo, tam, ip };
  lista.push(nuevo);
  await env.MI_CLIMA.put("reportes", JSON.stringify(lista.slice(-300)));
  const { ip: _, ...publico } = nuevo;
  return json({ ok: true, reporte: publico }, 200, cors);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = encabezadosCors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (request.method === "GET" || request.method === "HEAD") {
      if (url.pathname === "/") return texto("Mi Clima: intermediario funcionando (versión 6)" + (env.MI_CLIMA ? " · avisos listos" : " · falta conectar el KV MI_CLIMA") + (env.CODIGO ? " · con código de invitación" : ""), 200, cors);
      if (url.pathname === "/rayos") return rayos(cors);
      if (url.pathname === "/smn") return smn(url, cors);
      const ms = url.pathname.match(RUTA_SINARAME);
      if (ms) return imagenSinarame(ms, cors);
      const m = url.pathname.match(RUTA_RADAR);
      if (m) return imagenRadar(m, cors);
    }
    if (url.pathname === "/reportes" && (request.method === "GET" || request.method === "POST")) {
      if (!env.MI_CLIMA) return texto("Falta conectar el espacio KV con el nombre MI_CLIMA", 503, cors);
      try { return await reportes(request, env, cors); } catch (e) { return texto("Error: " + e.message, 500, cors); }
    }
    const rutasAvisos = ["/vapid", "/suscribir", "/ubicacion", "/desuscribir", "/probar", "/aviso", "/estado"];
    if (rutasAvisos.includes(url.pathname)) {
      if (!env.MI_CLIMA) return texto("Falta conectar el espacio KV con el nombre MI_CLIMA", 503, cors);
      try {
        if (request.method === "GET" && url.pathname === "/vapid") return json({ publica: (await clavesVapid(env)).publica, pideCodigo: !!env.CODIGO }, 200, cors);
        if (request.method === "GET" && url.pathname === "/aviso") return avisoGuardado(url, env, cors);
        if (request.method === "GET" && url.pathname === "/estado") return estadoGuardado(url, env, cors);
        if (request.method === "POST" && url.pathname === "/suscribir") return suscribir(request, env, cors);
        if (request.method === "POST" && url.pathname === "/ubicacion") return ubicacion(request, env, cors);
        if (request.method === "POST" && url.pathname === "/desuscribir") return desuscribir(request, env, cors);
        if (request.method === "POST" && url.pathname === "/probar") return probar(request, env, cors);
      } catch (e) {
        return texto("Error: " + e.message, 500, cors);
      }
      return texto("Método no permitido", 405, cors);
    }
    if (!["GET", "HEAD", "POST"].includes(request.method)) return texto("Método no permitido", 405, cors, { "Allow": "GET, HEAD, POST, OPTIONS" });
    return texto("No encontrado", 404, cors);
  },

  async scheduled(event, env, ctx) {
    if (!env.MI_CLIMA) return;
    const m = /^\*\/(\d+)\s/.exec((event && event.cron) || "");
    ctx.waitUntil(revisar(env, event && event.scheduledTime, m ? Number(m[1]) : 5));
  }
};
