import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app  = express();
const port = process.env.PORT || 3000;

// Nama tabel utama di Supabase
const TABLE_READINGS      = 'readings';
const TABLE_DEVICE_STATUS = 'device_status';
const ESP32_DEVICE_ID = process.env.ESP32_DEVICE_ID || 'solar-tracker-01';
const DEVICE_OFFLINE_AFTER_MS = 90_000;

const configuredFrontendOrigins = (process.env.FRONTEND_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const localFrontendOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const productionFrontendOrigins = ['https://dashboard-theta-silk-86.vercel.app'];
const allowedFrontendOrigins = [...new Set([
    ...configuredFrontendOrigins,
    ...localFrontendOrigins,
    ...productionFrontendOrigins
])];

app.use(cors({ origin: allowedFrontendOrigins }));


app.use((req, res, next) => {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
        const chunks = [];
        req.on('data', chunk => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
        req.on('end', () => {
            const rawBody  = Buffer.concat(chunks).toString('utf8');
            // Ganti semua :nan/ : nan dengan :0 (case-insensitive)
            const sanitized = rawBody.replace(/:\s*nan\b/gi, ':0');
            try {
                req.body = JSON.parse(sanitized);
            } catch (e) {
                return res.status(400).json({ success: false, error: 'JSON tidak valid: ' + e.message });
            }
            next();
        });
        req.on('error', err => {
            if (req.aborted || err.code === 'ECONNRESET' || err.message === 'aborted') {
                return;
            }
            next(err);
        });
    } else {
        next();
    }
});

// ── Inisialisasi Supabase ──────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL        || 'https://placeholder.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || 'placeholder_service_key';
const supabase    = createClient(supabaseUrl, supabaseKey);
let supabaseConnectionLogged = false;
const loggedApiOrigins = new Set();

function logApiConnection(req) {
    const referer = req.get('referer');
    let origin = req.get('origin') || 'not-provided';
    if (origin === 'not-provided' && referer) {
        try {
            origin = new URL(referer).origin;
        } catch {
            origin = 'invalid-referer';
        }
    }

    if (!loggedApiOrigins.has(origin)) {
        loggedApiOrigins.add(origin);
        console.info(`[connection] API request received: ${req.method} /api${req.path}; origin=${origin}`);
    }
}

function logSupabaseConnection(operation) {
    if (supabaseConnectionLogged) return;
    supabaseConnectionLogged = true;
    console.info(`[connection] Supabase query succeeded: ${operation}`);
}

app.use('/api', (req, res, next) => {
    logApiConnection(req);
    next();
});

// ── API Key Security ───────────────────────────────────────────────────────
const API_SECRET_KEY = process.env.HARDWARE_API_KEY;
if (!API_SECRET_KEY) {
    throw new Error('HARDWARE_API_KEY must be set in the backend environment');
}

const requireApiKey = (req, res, next) => {
    if (req.method === 'GET' && ['/health', '/readings', '/status'].includes(req.path)) {
        return next();
    }
    if (req.method === 'POST' && req.path === '/dashboard-heartbeat') {
        return next();
    }

    const clientKey = req.headers['x-api-key'];
    if (!clientKey || clientKey !== API_SECRET_KEY) {
        return res.status(401).json({ success: false, error: 'Akses Ditolak: API Key tidak valid' });
    }
    next();
};

app.use('/api', requireApiKey);

// ── Rate Limiter Sederhana (per IP, max 10 req/detik) ─────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX       = 10;

function rateLimiter(req, res, next) {
    const ip    = req.ip || req.connection.remoteAddress;
    const now   = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

    if (now > entry.resetAt) {
        entry.count   = 1;
        entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
    } else {
        entry.count++;
    }

    rateLimitMap.set(ip, entry);

    if (entry.count > RATE_LIMIT_MAX) {
        return res.status(429).json({ success: false, error: 'Terlalu banyak request. Coba lagi sebentar.' });
    }
    next();
}

app.use('/api', rateLimiter);

// ── Helper: Validasi angka ─────────────────────────────────────────────────
function safeNum(val, fallback = 0) {
    const n = parseFloat(val);
    return isFinite(n) ? n : fallback;
}

// =============================================================================
// ENDPOINT 1: Terima data sensor dari ESP32
// POST /api/sensor
//
// Field yang DIKIRIM firmware ESP32 (nama asli):
// {
//   "ldr_tl"     : 512,       → DB: ldr_top_left
//   "ldr_tr"     : 498,       → DB: ldr_top_right
//   "ldr_bl"     : 520,       → DB: ldr_bottom_left
//   "ldr_br"     : 505,       → DB: ldr_bottom_right
//   "voltage"    : "12.400",  → DB: voltage  (tegangan panel)
//   "current"    : "150.00",  → DB: current  (arus panel mA)
//   "capacity"   : "0.00",   → DB: battery_current
//   "fuzzy_dh"  : "2.000",   → DB: error_horizontal
//   "fuzzy_dv"  : "-1.170",  → DB: error_vertikal
//   "temperature": "31.5",   → DB: temperature  (opsional, hanya jika DHT11 OK)
//   "humidity"   : "60.0"    → DB: humidity     (opsional, hanya jika DHT11 OK)
// }
// =============================================================================
app.post('/api/sensor', async (req, res) => {
    try {
        const body = req.body;

        // ── Baca field firmware — support nama lama (firmware) & nama baru ──────
        // LDR: firmware kirim ldr_tl/tr/bl/br  →  DB: ldr_top_left dst
        const ldrTopLeft      = Math.round(safeNum(body.ldr_tl  ?? body.ldr_top_left));
        const ldrTopRight     = Math.round(safeNum(body.ldr_tr  ?? body.ldr_top_right));
        const ldrBottomLeft   = Math.round(safeNum(body.ldr_bl  ?? body.ldr_bottom_left));
        const ldrBottomRight  = Math.round(safeNum(body.ldr_br  ?? body.ldr_bottom_right));

        // Tegangan & arus panel (bisa berupa string "0.000" — safeNum handle via parseFloat)
        const voltage         = safeNum(body.voltage);
        const current         = safeNum(body.current);  // mA

        // capacity dari firmware → simpan sebagai battery_current (tidak ada kolom capacity di DB)
        const batteryCurrent  = safeNum(body.capacity        ?? body.battery_current);
        const batteryVoltage  = safeNum(body.battery_voltage);  // opsional

        // Fuzzy/error: firmware kirim fuzzy_dh/dv  →  DB: error_horizontal/vertikal
        const errorHorizontal = Math.round(safeNum(body.fuzzy_dh ?? body.error_horizontal));
        const errorVertikal   = Math.round(safeNum(body.fuzzy_dv ?? body.error_vertikal));

        // Servo (opsional — bisa dikirim bareng sensor atau lewat /api/servo)
        const rawAzimuth = body.servo_azimuth ?? body.azimuth;
        const rawElevation = body.servo_elevation ?? body.elevation;
        
        const servoAzimuth   = (rawAzimuth != null)   ? Math.round(safeNum(rawAzimuth))   : null;
        const servoElevation = (rawElevation != null) ? Math.round(safeNum(rawElevation)) : null;

        // DHT11 — hanya insert jika ada nilainya (tidak kirim saat sensor belum terpasang)
        const temperature     = (body.temperature != null) ? safeNum(body.temperature) : null;
        const humidity        = (body.humidity    != null) ? safeNum(body.humidity)    : null;

        const deviceId        = body.device_id || ESP32_DEVICE_ID;

        // Hitung daya: P = V × I (arus mA → A)
        const power = +(voltage * (current / 1000)).toFixed(4);

        // ── Insert ke tabel readings ───────────────────────────────────────
        const insertData = {
            device_id:        deviceId,
            voltage:          +voltage.toFixed(3),
            current:          +current.toFixed(2),
            power,
            battery_voltage:  +batteryVoltage.toFixed(3),
            battery_current:  +batteryCurrent.toFixed(2),
            ldr_top_left:     ldrTopLeft,
            ldr_top_right:    ldrTopRight,
            ldr_bottom_left:  ldrBottomLeft,
            ldr_bottom_right: ldrBottomRight,
            error_horizontal: errorHorizontal,
            error_vertikal:   errorVertikal,
        };

        // Tambahkan atribut opsional hanya jika ada nilainya
        if (servoAzimuth   !== null) insertData.servo_azimuth   = servoAzimuth;
        if (servoElevation !== null) insertData.servo_elevation = servoElevation;
        if (temperature    !== null) insertData.temperature     = +temperature.toFixed(1);
        if (humidity       !== null) insertData.humidity        = +humidity.toFixed(1);

        const { error: insertError } = await supabase
            .from(TABLE_READINGS)
            .insert([insertData]);

        if (insertError) throw insertError;
        logSupabaseConnection('POST /api/sensor');
        console.info(`[data] ESP32 -> Backend -> Supabase: sensor row saved; ${JSON.stringify(insertData)}`);

        // ── Update device_status (upsert) ─────────────────────────────────
        const { error: statusError } = await supabase
            .from(TABLE_DEVICE_STATUS)
            .upsert(
                { device_id: deviceId, last_seen: new Date().toISOString() },
                { onConflict: 'device_id' }
            );

        if (statusError) throw statusError;

        res.status(200).json({ success: true, message: 'Data sensor tersimpan', deviceId });
    } catch (err) {
        supabaseConnectionLogged = false;
        console.error('[/api/sensor] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================================================
// ENDPOINT 2: Terima posisi servo dari ESP32 (compatibility endpoint)
// POST /api/servo
// Catatan: servo data juga bisa dikirim lewat /api/sensor sekaligus.
// Endpoint ini dipertahankan agar firmware lama tidak perlu diubah.
// =============================================================================
app.post('/api/servo', async (req, res) => {
    try {
        const azimuth   = Math.round(safeNum(req.body?.azimuth));
        const elevation = Math.round(safeNum(req.body?.elevation));

        if (azimuth < 0 || azimuth > 180 || elevation < 0 || elevation > 180) {
            return res.status(400).json({ success: false, error: 'Sudut di luar rentang 0–180°' });
        }

        // Simpan ke kolom servo di tabel readings (insert baris baru)
        const { error } = await supabase
            .from(TABLE_READINGS)
            .insert([{ servo_azimuth: azimuth, servo_elevation: elevation }]);

        if (error) throw error;
        logSupabaseConnection('POST /api/servo');
        console.info(`[data] ESP32 -> Backend -> Supabase: servo row saved; ${JSON.stringify({ azimuth, elevation })}`);
        res.status(200).json({ success: true, message: 'Posisi servo tersimpan' });
    } catch (err) {
        supabaseConnectionLogged = false;
        console.error('[/api/servo] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================================================
// ENDPOINT 3: Health check — cek koneksi backend ke Supabase
// GET /api/health
// =============================================================================
app.get('/api/health', async (req, res) => {
    try {
        const { error } = await supabase
            .from(TABLE_READINGS)
            .select('id')
            .limit(1);

        if (error) throw error;
        logSupabaseConnection('GET /api/health');
        res.status(200).json({ success: true, message: 'Backend & Supabase Online' });
    } catch (err) {
        supabaseConnectionLogged = false;
        console.error('[/api/health] Supabase connection failed:', err.message);
        res.status(500).json({ success: false, error: 'Database disconnected' });
    }
});

// Public connection status for the backend landing page and dashboard diagnostics.
app.get('/api/status', async (req, res) => {
    let supabaseConnected = false;
    let dashboardLastSeen = null;
    let esp32LastSeen = null;
    try {
        const { error } = await supabase
            .from(TABLE_READINGS)
            .select('id')
            .limit(1);

        if (error) throw error;
        supabaseConnected = true;
        logSupabaseConnection('GET /api/status');
    } catch (err) {
        supabaseConnectionLogged = false;
        console.error('[/api/status] Supabase connection failed:', err.message);
    }

    if (supabaseConnected) {
        try {
            const { data, error } = await supabase
                .from(TABLE_DEVICE_STATUS)
                .select('last_seen')
                .eq('device_id', 'dashboard-web')
                .maybeSingle();

            if (error) throw error;
            dashboardLastSeen = data?.last_seen || null;
        } catch (err) {
            console.error('[/api/status] Dashboard heartbeat lookup failed:', err.message);
        }

        try {
            const { data, error } = await supabase
                .from(TABLE_DEVICE_STATUS)
                .select('last_seen')
                .eq('device_id', ESP32_DEVICE_ID)
                .maybeSingle();

            if (error) throw error;
            esp32LastSeen = data?.last_seen || null;
        } catch (err) {
            console.error('[/api/status] ESP32 heartbeat lookup failed:', err.message);
        }
    }

    const dashboardConnected = dashboardLastSeen !== null
        && Number.isFinite(Date.parse(dashboardLastSeen))
        && Date.now() - Date.parse(dashboardLastSeen) <= 30_000;
    const esp32Connected = esp32LastSeen !== null
        && Number.isFinite(Date.parse(esp32LastSeen))
        && Date.now() - Date.parse(esp32LastSeen) <= DEVICE_OFFLINE_AFTER_MS;

    res.status(200).json({
        success: true,
        backend: { connected: true },
        supabase: { connected: supabaseConnected },
        dashboard: {
            connected: dashboardConnected,
            lastSeen: dashboardLastSeen
        },
        esp32: {
            deviceId: ESP32_DEVICE_ID,
            connected: esp32Connected,
            lastSeen: esp32LastSeen
        },
        checkedAt: new Date().toISOString()
    });
});

app.post('/api/dashboard-heartbeat', async (req, res) => {
    try {
        const lastSeen = new Date().toISOString();
        const { error } = await supabase
            .from(TABLE_DEVICE_STATUS)
            .upsert(
                { device_id: 'dashboard-web', last_seen: lastSeen },
                { onConflict: 'device_id' }
            );

        if (error) throw error;
        res.status(200).json({ success: true, lastSeen });
    } catch (err) {
        console.error('[/api/dashboard-heartbeat] Error:', err.message);
        res.status(500).json({ success: false, error: 'Dashboard heartbeat could not be saved' });
    }
});

// =============================================================================
// ENDPOINT 5: Ambil data terbaru — untuk dashboard
// GET /api/latest
// =============================================================================
app.get('/api/latest', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from(TABLE_READINGS)
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (error && error.code !== 'PGRST116') throw error;
        logSupabaseConnection('GET /api/latest');
        res.status(200).json({ success: true, data: data || null });
    } catch (err) {
        supabaseConnectionLogged = false;
        console.error('[/api/latest] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Read-only telemetry endpoint for the web dashboard. Device writes remain API-key protected.
app.get('/api/readings', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 1000);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const { from, to, since, order } = req.query;

        if ([from, to, since].some(value => value && !Number.isFinite(Date.parse(value)))) {
            return res.status(400).json({ success: false, error: 'Rentang waktu tidak valid' });
        }

        let query = supabase
            .from(TABLE_READINGS)
            .select('*')
            .order('created_at', { ascending: order !== 'desc' })
            .range(offset, offset + limit - 1);

        if (from) query = query.gte('created_at', from);
        if (to) query = query.lt('created_at', to);
        if (since) query = query.gte('created_at', since);

        const { data, error } = await query;
        if (error) throw error;
        logSupabaseConnection('GET /api/readings');
        const liveRows = since
            ? (data || []).filter(row => Date.parse(row.created_at) > Date.parse(since))
            : [];
        if (liveRows.length) {
            const latest = [...liveRows].reverse().find(row =>
                row.voltage != null || row.power != null || row.ldr_top_left != null
            ) || liveRows[liveRows.length - 1];
            console.info(`[data] Supabase -> Backend: fetched ${liveRows.length} new live reading(s); latest=${JSON.stringify({
                id: latest.id,
                device_id: latest.device_id,
                created_at: latest.created_at,
                voltage: latest.voltage,
                current: latest.current,
                power: latest.power
            })}`);
        }
        res.status(200).json({ success: true, source: 'supabase', count: data?.length || 0, data: data || [] });
    } catch (err) {
        supabaseConnectionLogged = false;
        console.error('[/api/readings] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="id">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>Status Koneksi · Solar Tracker</title>
    <style>
        * { box-sizing: border-box; }
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #0a0d14; color: #e8edf5; font: 15px/1.5 system-ui, sans-serif; }
        main { width: min(100%, 560px); padding: 28px; background: #101626; border: 1px solid #26334d; border-radius: 16px; }
        h1 { margin: 0 0 6px; font-size: 22px; }
        .subtitle, .updated { color: #91a0ba; }
        .statuses { display: grid; gap: 12px; margin: 24px 0; }
        .status { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 15px; background: #0b1120; border: 1px solid #26334d; border-radius: 10px; }
        .label { display: flex; align-items: center; gap: 10px; font-weight: 600; }
        .dot { width: 10px; height: 10px; border-radius: 50%; background: #718096; }
        .connected .dot { background: #00e5a0; box-shadow: 0 0 10px #00e5a0; }
        .disconnected .dot { background: #ff626e; box-shadow: 0 0 8px #ff626e; }
        .state { text-align: right; color: #91a0ba; font-size: 13px; }
        .connected .state { color: #00e5a0; }
        .disconnected .state { color: #ff858d; }
        .updated { font-size: 12px; }
        @media (max-width: 420px) { main { padding: 20px; } .status { align-items: flex-start; flex-direction: column; gap: 6px; } .state { padding-left: 20px; text-align: left; } }
    </style>
</head>
<body>
    <main>
        <h1>Status Koneksi Solar Tracker</h1>
        <p class="subtitle">Status dashboard dan database diperbarui otomatis.</p>
        <section class="statuses" aria-live="polite">
            <div class="status" id="dashboard"><span class="label"><span class="dot"></span>Dashboard → Backend</span><span class="state">Memeriksa...</span></div>
            <div class="status" id="supabase"><span class="label"><span class="dot"></span>Backend → Supabase</span><span class="state">Memeriksa...</span></div>
        </section>
        <p class="updated" id="updated">Pengecekan koneksi berlangsung...</p>
    </main>
    <script>
        const setStatus = (id, connected, detail) => {
            const row = document.getElementById(id);
            row.className = 'status ' + (connected ? 'connected' : 'disconnected');
            row.querySelector('.state').textContent = detail || (connected ? 'Terhubung' : 'Tidak terhubung');
        };
        async function refreshStatus() {
            try {
                const response = await fetch('/api/status', { cache: 'no-store' });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const result = await response.json();
                setStatus('dashboard', result.dashboard.connected,
                    result.dashboard.connected ? 'Terhubung' : 'Belum ada koneksi dashboard terbaru');
                setStatus('supabase', result.supabase.connected);
                document.getElementById('updated').textContent =
                    'Pembaruan terakhir: ' + new Date(result.checkedAt).toLocaleString('id-ID');
            } catch (error) {
                setStatus('dashboard', false, 'Backend tidak dapat dijangkau');
                setStatus('supabase', false, 'Status tidak tersedia');
                document.getElementById('updated').textContent = 'Gagal memeriksa status koneksi: ' + error.message;
            }
        }
        refreshStatus();
        setInterval(refreshStatus, 5000);
    </script>
</body>
</html>`);
});

export default app;

if (!process.env.VERCEL) {
    app.listen(port, () => {
        console.log(`\n🌞 IoT Solar Tracker Backend`);
        console.log(`   Server   : http://localhost:${port}`);
        console.log(`   Supabase : ${supabaseUrl.replace('https://', '').split('.')[0]}...supabase.co`);
        console.log(`   Status   : Running ✓\n`);
    });
}
