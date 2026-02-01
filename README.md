# 🤖 CelExpress WhatsApp + ChatBot

Sistema completo de cobranza por WhatsApp para **LMV CREDIA SA DE CV**.

## ✨ Funcionalidades

- ✅ Envío masivo controlado (anti-baneo)
- ✅ ChatBot automático de respuestas
- ✅ Notificación a gestores (Alfonso y Gisella)
- ✅ Interfaz web de administración
- ✅ API REST completa

## 👥 Gestores Configurados

| Nombre | Teléfono |
|--------|----------|
| Lic. Alfonso | 5564304984 |
| Lic. Gisella | 5526889735 |

---

## 🚀 Despliegue en Render

### Paso 1: Subir a GitHub

```bash
# En tu computadora
cd celexpress-whatsapp-render
git init
git add .
git commit -m "CelExpress WhatsApp Bot"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/celexpress-whatsapp.git
git push -u origin main
```

### Paso 2: Crear servicio en Render

1. Ve a [render.com](https://render.com) y crea cuenta
2. Click en **"New +"** → **"Web Service"**
3. Conecta tu repositorio de GitHub
4. Configura:
   - **Name:** `celexpress-whatsapp`
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free (o Starter $7/mes para que no duerma)

5. En **Environment Variables** agrega:
   ```
   DELAY_ENTRE_MENSAJES=10000
   MENSAJES_POR_LOTE=15
   HORA_INICIO=9
   HORA_FIN=20
   ```

6. Click en **"Create Web Service"**

### Paso 3: Conectar WhatsApp

1. Espera que Render termine de deployar
2. Abre tu URL: `https://celexpress-whatsapp.onrender.com`
3. Click en **"Conectar"** → **"Ver QR"**
4. Escanea el QR con WhatsApp del número **5544621100**
5. ¡Listo! El bot ya está funcionando 24/7

---

## 🔧 Mantener activo (Plan Gratuito)

El plan gratis de Render "duerme" después de 15 minutos sin actividad.

### Solución: UptimeRobot (Gratis)

1. Ve a [uptimerobot.com](https://uptimerobot.com) y crea cuenta
2. Click en **"Add New Monitor"**
3. Configura:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** CelExpress WhatsApp
   - **URL:** `https://celexpress-whatsapp.onrender.com/ping`
   - **Monitoring Interval:** 5 minutes

4. Click en **"Create Monitor"**

Esto hace ping cada 5 minutos y mantiene el servicio activo.

---

## 📱 Flujo del ChatBot

```
Cliente responde "HOLA"
        ↓
    MENÚ PRINCIPAL
    1️⃣ Quiero pagar
    2️⃣ Convenio
    3️⃣ Consultar saldo
    4️⃣ Hablar con asesor
        ↓
    Si necesita gestor →
    Notifica a Alfonso o Gisella
        ↓
    Gestor contacta al cliente
```

---

## 🔌 API Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/` | Interfaz web |
| GET | `/health` | Health check |
| GET | `/ping` | Keep-alive |
| POST | `/api/conectar` | Conectar WhatsApp |
| GET | `/api/estado` | Ver estado |
| GET | `/api/qr` | Obtener QR |
| POST | `/api/enviar-mensaje` | Enviar mensaje |
| POST | `/api/enviar-masivo` | Envío masivo |
| POST | `/api/subir-excel` | Subir Excel |
| GET | `/api/chatbot/estadisticas` | Stats chatbot |
| GET | `/api/chatbot/interacciones` | Ver historial |

---

## 📊 Cargar Cartera

### Opción 1: Subir Excel

Sube un Excel con columnas: `Cliente`, `Teléfono`, `Saldo`, `Días Atraso`

### Opción 2: API

```bash
curl -X POST https://tu-app.onrender.com/api/chatbot/cartera \
  -H "Content-Type: application/json" \
  -d '{
    "clientes": [
      {"nombre": "Juan Pérez", "telefono": "5512345678", "saldo": 2500, "diasAtraso": 45}
    ]
  }'
```

---

## ⚠️ Importante

- El primer deploy tarda 2-3 minutos
- Después de escanear QR, la sesión se guarda
- Si se desconecta, ve a la interfaz web y reconecta
- El plan gratis tiene 750 horas/mes (suficiente si usas UptimeRobot)

---

## 🔄 Actualizar

```bash
git add .
git commit -m "Actualización"
git push
```

Render re-deploya automáticamente.

---

**LMV CREDIA SA DE CV**
