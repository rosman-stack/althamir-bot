// Noor y el límite de uso de Groq (repo althamir-bot). Reemplaza a un .patch.
//  - Chat de la tienda: si Groq responde 429 (límite de tokens por minuto), la función espera lo que indique y reintenta una
//    vez; si sigue ocupado, el cliente ve "Estoy atendiendo a varias personas…" con tu WhatsApp. Ya no se muestra nunca el
//    error de Groq (traía el ID de tu organización y el enlace de facturación).
//  - Se manda al modelo solo el prompt y los últimos 8 turnos: menos tokens por mensaje.
//  - Noor de WhatsApp: ante un 429 espera y reintenta una vez; si sigue, deriva al cliente a un asesor sin "error técnico".
//  - Monitor /health: un 429 de Groq ya no cuenta como caída (antes mandaba una falsa alarma a Telegram) y, si Groq respondió
//    bien hace poco, no gasta otra llamada de cuota en el ping.
// Uso, desde la carpeta del repo althamir-bot:
//   node aplicar-noor-limites.mjs --probar    (solo revisa, no cambia nada)
//   node aplicar-noor-limites.mjs             (aplica los cambios)
// Respeta tus cambios locales y los saltos de línea de Windows. Si algún trozo de tu archivo es
// distinto, no toca NADA y te dice cuál es.
import fs from "node:fs";
import path from "node:path";

const PROBAR = process.argv.includes("--probar");

function leer(f) {
  const raw = fs.readFileSync(f, "utf8");
  return { txt: raw.replace(/\r\n/g, "\n"), crlf: raw.includes("\r\n") };
}
function aplicarPares(txt, pares) {
  const malos = [];
  let aplicados = 0, ya = 0;
  pares.forEach(([o, n], i) => {
    const veces = txt.split(o).length - 1;
    if (!o.includes(n) && txt.includes(n)) { ya++; return; }          // ya estaba aplicado
    if (veces === 1) { txt = txt.replace(o, () => n); aplicados++; return; }
    if (o.includes(n) && veces === 0 && txt.includes(n)) { ya++; return; } // borrado ya hecho
    const donde = o.split("\n").reduce((a, l) => (l.trim().length > a.trim().length ? l : a), "");
    malos.push(`cambio ${i + 1}: ${veces === 0 ? "no encontré el texto original (esa zona de tu archivo es distinta)" : "el texto aparece " + veces + " veces"} → «${donde.trim().slice(0, 80)}»`);
  });
  return { txt, aplicados, ya, malos };
}

const ARCHIVOS = {
 "netlify/functions/noor.js": [
  [
   "const MAX_REQUESTS_POR_MINUTO = 12;\nconst registroPeticiones = new Map(); // ip -> [timestamps]",
   "const MAX_REQUESTS_POR_MINUTO = 12;\n\n// Groq limita los tokens por minuto de TODA la organización (el plan gratuito de gpt-oss-20b: 8,000), y el bot de\n// WhatsApp comparte ese cupo. Para gastar menos por mensaje solo mandamos el prompt y los últimos turnos de la charla.\nconst MAX_TURNOS = 8;\n// Si Groq responde 429, esperamos lo que indique (si es corto) y reintentamos una vez. Netlify corta a los ~10 s.\nconst ESPERA_MAX_SEG = 3;\nconst esperar = (ms) => new Promise((r) => setTimeout(r, ms));\n\nfunction segundosDeEspera(r) {\n  const h = parseFloat(r.retryAfter);\n  if (isFinite(h) && h > 0) return h;\n  const m = /try again in ([0-9.]+)\\s*(ms|s)/i.exec(String(r.data || ''));\n  if (m) return m[2].toLowerCase() === 'ms' ? parseFloat(m[1]) / 1000 : parseFloat(m[1]);\n  return 3;\n}\n\nfunction pedirAGroq(payload, apiKey) {\n  return new Promise((resolve) => {\n    const req = https.request({\n      hostname: 'api.groq.com',\n      path: '/openai/v1/chat/completions',\n      method: 'POST',\n      headers: {\n        'Content-Type': 'application/json',\n        'Authorization': 'Bearer ' + apiKey,\n        'Content-Length': Buffer.byteLength(payload)\n      }\n    }, (res) => {\n      let data = '';\n      res.on('data', (chunk) => { data += chunk; });\n      res.on('end', () => resolve({ status: res.statusCode, data, retryAfter: res.headers && res.headers['retry-after'] }));\n    });\n    req.on('error', (err) => resolve({ status: 0, data: '', error: err.message }));\n    req.write(payload);\n    req.end();\n  });\n}\nconst registroPeticiones = new Map(); // ip -> [timestamps]"
  ],
  [
   "\n  const payload = JSON.stringify({",
   "\n  // Prompt del sistema + últimos turnos (que empiecen con un mensaje del cliente)\n  const sistema = body.messages.filter((m) => m && m.role === 'system').slice(0, 1);\n  const resto = body.messages.filter((m) => m && m.role !== 'system').slice(-MAX_TURNOS);\n  while (resto.length && resto[0].role !== 'user') resto.shift();\n\n  const payload = JSON.stringify({"
  ],
  [
   "    temperature: 0.7,\n    messages: body.messages\n  });\n\n  return new Promise((resolve) => {\n    const options = {\n      hostname: 'api.groq.com',\n      path: '/openai/v1/chat/completions',\n      method: 'POST',\n      headers: {\n        'Content-Type': 'application/json',\n        'Authorization': 'Bearer ' + apiKey,\n        'Content-Length': Buffer.byteLength(payload)\n      }\n    };\n\n    const req = https.request(options, (res) => {\n      let data = '';\n      res.on('data', (chunk) => { data += chunk; });\n      res.on('end', () => {\n        resolve({ statusCode: res.statusCode, headers, body: data });\n      });\n    });\n\n    req.on('error', (err) => {\n      resolve({ statusCode: 500, headers, body: JSON.stringify({ error: err.message }) });\n    });\n\n    req.write(payload);\n    req.end();\n  });\n};",
   "    temperature: 0.7,\n    messages: [...sistema, ...resto]\n  });\n\n  let r = await pedirAGroq(payload, apiKey);\n  if (r.status === 429 && segundosDeEspera(r) <= ESPERA_MAX_SEG) {\n    await esperar(Math.ceil(segundosDeEspera(r) * 1000) + 250);\n    r = await pedirAGroq(payload, apiKey);\n  }\n  if (r.status === 200) return { statusCode: 200, headers, body: r.data };\n\n  // Nunca se le devuelve al cliente el error de Groq (trae datos de tu cuenta): se registra aquí y se responde algo neutro\n  console.error('[noor] Groq respondió', r.status, String(r.data || r.error || '').slice(0, 300));\n  if (r.status === 429) {\n    return { statusCode: 503, headers, body: JSON.stringify({\n      error: { code: 'busy', message: 'Noor está atendiendo a varias personas.' },\n      retry_after: Math.min(8, Math.ceil(segundosDeEspera(r)))\n    }) };\n  }\n  return { statusCode: 502, headers, body: JSON.stringify({ error: { code: 'unavailable', message: 'Noor no está disponible por ahora.' } }) };\n};"
  ]
 ],
 "index.html": [
  [
   "      { role: 'system', content: systemWithCart },\n      ...noorHistory.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))\n    ];",
   "      { role: 'system', content: systemWithCart },\n      ...noorHistory.slice(-8).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))\n    ];"
  ],
  [
   "    // Llamar al proxy serverless (la key de Groq vive en Netlify, nunca en el cliente)\n    const res = await fetch('/.netlify/functions/noor', {\n      method: 'POST',",
   "    // Llamar al proxy serverless (la key de Groq vive en Netlify, nunca en el cliente)\n    const pedirNoor = () => fetch('/.netlify/functions/noor', {\n      method: 'POST',"
  ],
  [
   "    });\n\n    const data = await res.json();\n\n    if (!res.ok) {\n      const errMsg = data?.error?.message || 'Error ' + res.status;\n      console.error('Noor Gemini error:', res.status, errMsg);\n      noorHideTyping();\n      noorAddMsg('bot', `⚠️ Error ${res.status}: ${errMsg}\\n\\nEscríbenos directamente 👉 wa.me/50252547623 🖤`);\n      setNoorQR('welcome');",
   "    });\n    let res = await pedirNoor();\n    let data = await res.json().catch(() => ({}));\n    // Noor ocupada (límite de uso del modelo): una espera corta y un único reintento automático (el \"escribiendo\" sigue visible)\n    if (res.status === 503 || res.status === 429) {\n      const seg = Math.min(8, Math.max(2, Number(data && data.retry_after) || 4));\n      await new Promise(r => setTimeout(r, seg * 1000));\n      res = await pedirNoor();\n      data = await res.json().catch(() => ({}));\n    }\n\n    if (!res.ok) {\n      console.error('Noor error:', res.status, data && data.error && data.error.code);\n      noorHideTyping();\n      const ocupada = res.status === 503 || res.status === 429;\n      noorAddMsg('bot', (ocupada ? 'Estoy atendiendo a varias personas a la vez 🙏 Intenta de nuevo en unos segundos.' : 'Ups, no pude responder en este momento.') + '\\n\\nO escríbenos directamente 👉 wa.me/50252547623 🖤');\n      setNoorQR('welcome');"
  ],
  [
   "    console.error('Noor fetch exception:', e);\n    noorAddMsg('bot', `⚠️ Error: ${e.message}\\n\\nEscríbenos directamente 👉 wa.me/50252547623 🖤`);\n    setNoorQR('welcome');",
   "    console.error('Noor fetch exception:', e);\n    noorAddMsg('bot', 'Ups, no pude responder en este momento.\\n\\nO escríbenos directamente 👉 wa.me/50252547623 🖤');\n    setNoorQR('welcome');"
  ]
 ],
 "index.js": [
  [
   "\nasync function llamarGroq(historial) {\n  const systemPrompt = await getNoorSystem();\n  const pedir = async (maxTokens) => {\n    const res = await axios.post(",
   "\nlet ultimoOkGroq = 0; // última vez que Groq respondió bien a un cliente (lo usa /health para no gastar llamadas de más)\nasync function llamarGroq(historial) {\n  const systemPrompt = await getNoorSystem();\n  const intentar = async (maxTokens) => {\n    const res = await axios.post("
  ],
  [
   "    );\n    const eleccion = res.data.choices?.[0];\n    return { texto: (eleccion?.message?.content || '').trim(), motivo: eleccion?.finish_reason };\n  };",
   "    );\n    ultimoOkGroq = Date.now();\n    const eleccion = res.data.choices?.[0];\n    return { texto: (eleccion?.message?.content || '').trim(), motivo: eleccion?.finish_reason };\n  };\n  // Límite de uso de Groq (429, tokens por minuto de toda la organización): esperamos lo que indique (si es corto) y\n  // reintentamos una vez; si sigue, devolvemos '' y el webhook deriva al cliente a un asesor (en vez de dar un error técnico).\n  const pedir = async (maxTokens, puedeReintentar = true) => {\n    try {\n      return await intentar(maxTokens);\n    } catch (e) {\n      if (!e.response || e.response.status !== 429) throw e;\n      const h = parseFloat(e.response.headers && e.response.headers['retry-after']);\n      const m = /try again in ([0-9.]+)\\s*(ms|s)/i.exec(JSON.stringify(e.response.data || ''));\n      const seg = isFinite(h) && h > 0 ? h : (m ? (m[2].toLowerCase() === 'ms' ? parseFloat(m[1]) / 1000 : parseFloat(m[1])) : 3);\n      if (puedeReintentar && seg <= 8) {\n        console.warn(`[Groq] Límite de uso (429): espero ${seg}s y reintento`);\n        await new Promise((r) => setTimeout(r, Math.ceil(seg * 1000) + 250));\n        return pedir(maxTokens, false);\n      }\n      console.warn('[Groq] Límite de uso (429) sin margen para reintentar: derivo a un asesor');\n      return { texto: '', motivo: 'rate_limit' };\n    }\n  };"
  ],
  [
   "  let r = await pedir(450);\n  if (!r.texto) {\n    console.warn(`[Groq] Respuesta vacía (finish_reason: ${r.motivo}) — reintentando con más margen`);",
   "  let r = await pedir(450);\n  if (!r.texto && r.motivo !== 'rate_limit') {\n    console.warn(`[Groq] Respuesta vacía (finish_reason: ${r.motivo}) — reintentando con más margen`);"
  ],
  [
   "    problemas.push('GROQ_API_KEY no configurada');\n  } else {",
   "    problemas.push('GROQ_API_KEY no configurada');\n  } else if (Date.now() - ultimoOkGroq < 15 * 60 * 1000) {\n    // Groq respondió bien a un cliente hace poco: no gastamos otra llamada de cuota en el ping\n  } else {"
  ],
  [
   "    } catch (e) {\n      problemas.push(`Groq falló: ${e.response?.status || ''} ${e.response?.data?.error?.message || e.message}`);\n    }",
   "    } catch (e) {\n      // 429 = límite de uso: la clave y el servicio funcionan, así que no es una caída (antes mandaba una falsa alarma a Telegram)\n      if (e.response?.status === 429) console.warn('[salud] Groq en límite de uso (429): no es una caída');\n      else problemas.push(`Groq falló: ${e.response?.status || ''} ${e.response?.data?.error?.message || e.message}`);\n    }"
  ]
 ]
};

// Si ya habías aplicado la versión anterior de este script, index.js solo necesita lo nuevo (monitor /health)
const DELTA_V1_INDEXJS = [
 [
  "\nasync function llamarGroq(historial) {",
  "\nlet ultimoOkGroq = 0; // última vez que Groq respondió bien a un cliente (lo usa /health para no gastar llamadas de más)\nasync function llamarGroq(historial) {"
 ],
 [
  "    );\n    const eleccion = res.data.choices?.[0];",
  "    );\n    ultimoOkGroq = Date.now();\n    const eleccion = res.data.choices?.[0];"
 ],
 [
  "    problemas.push('GROQ_API_KEY no configurada');\n  } else {",
  "    problemas.push('GROQ_API_KEY no configurada');\n  } else if (Date.now() - ultimoOkGroq < 15 * 60 * 1000) {\n    // Groq respondió bien a un cliente hace poco: no gastamos otra llamada de cuota en el ping\n  } else {"
 ],
 [
  "    } catch (e) {\n      problemas.push(`Groq falló: ${e.response?.status || ''} ${e.response?.data?.error?.message || e.message}`);\n    }",
  "    } catch (e) {\n      // 429 = límite de uso: la clave y el servicio funcionan, así que no es una caída (antes mandaba una falsa alarma a Telegram)\n      if (e.response?.status === 429) console.warn('[salud] Groq en límite de uso (429): no es una caída');\n      else problemas.push(`Groq falló: ${e.response?.status || ''} ${e.response?.data?.error?.message || e.message}`);\n    }"
 ]
];
{
  const idx = fs.existsSync("index.js") ? leer("index.js").txt : "";
  if (idx.includes("puedeReintentar") && !idx.includes("ultimoOkGroq")) ARCHIVOS["index.js"] = DELTA_V1_INDEXJS;
}

for (const f of Object.keys(ARCHIVOS)) {
  if (!fs.existsSync(f)) { console.error(`✘ No encuentro ${f} aquí. Abre la terminal DENTRO de la carpeta del repo althamir-bot (y haz git pull antes).`); process.exit(1); }
}
const resultados = [];
let fallos = 0;
for (const [f, pares] of Object.entries(ARCHIVOS)) {
  const { txt, crlf } = leer(f);
  const r = aplicarPares(txt, pares);
  resultados.push({ f, crlf, ...r });
  console.log(`${r.malos.length ? "✘" : "✔"} ${f}: ${r.aplicados} cambios por aplicar, ${r.ya} ya estaban`);
  r.malos.forEach((m) => console.log("     " + m));
  fallos += r.malos.length;
}
if (fallos) { console.log(`\n✘ ${fallos} cambio(s) no se pudieron aplicar. No modifiqué ningún archivo. Mándame esta salida completa.`); process.exit(2); }
if (PROBAR) { console.log("\n(modo --probar) Todo se puede aplicar. No modifiqué nada."); process.exit(0); }
for (const r of resultados) if (r.aplicados) fs.writeFileSync(r.f, r.crlf ? r.txt.replace(/\n/g, "\r\n") : r.txt);
console.log("\n✔ Listo. Revisa con: git status   y   git diff");
