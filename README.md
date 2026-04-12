# 🖤 Noor — Bot WhatsApp Althamir

## Despliegue en Railway (gratis)

### Paso 1: Subir a GitHub
1. Crea cuenta en github.com
2. Nuevo repositorio → "althamir-bot" → privado
3. Sube estos archivos (index.js, package.json, Procfile)
4. NO subas el archivo .env

### Paso 2: Desplegar en Railway
1. Ve a railway.app → Login con GitHub
2. "New Project" → "Deploy from GitHub repo"
3. Selecciona "althamir-bot"
4. Railway despliega automáticamente

### Paso 3: Variables de entorno en Railway
En tu proyecto Railway → Variables → agrega:
- WHATSAPP_TOKEN = (tu token de Meta)
- PHONE_NUMBER_ID = 1029910316880792
- WHATSAPP_BUSINESS_ACCOUNT_ID = 994127326561251
- GROQ_API_KEY = (tu key de Groq)
- VERIFY_TOKEN = althamir_noor_2025

### Paso 4: Obtener URL del bot
Railway te da una URL tipo: https://althamir-bot-xxxx.railway.app
Cópiala — la necesitas para el webhook de Meta

### Paso 5: Configurar Webhook en Meta
1. Ve a developers.facebook.com → tu app → WhatsApp → Configuración
2. "Configurar webhooks"
3. URL: https://tu-url.railway.app/webhook
4. Token de verificación: althamir_noor_2025
5. Suscríbete a: messages

## Listo — Noor responde automáticamente en WhatsApp 🖤
