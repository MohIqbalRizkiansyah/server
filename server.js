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
const TABLE_COMMANDS      = 'system_commands';

app.use(cors());


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

// ── API Key Security ───────────────────────────────────────────────────────
const API_SECRET_KEY = process.env.HARDWARE_API_KEY || 'arduino_solar_tracker_key';

const requireApiKey = (req, res, next) => {
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

        const deviceId        = body.device_id || 'solar-tracker-01';

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

        // ── Update device_status (upsert) ─────────────────────────────────
        await supabase
            .from(TABLE_DEVICE_STATUS)
            .upsert(
                { device_id: deviceId, last_seen: new Date().toISOString() },
                { onConflict: 'device_id' }
            );

        res.status(200).json({ success: true, message: 'Data sensor tersimpan' });
    } catch (err) {
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
        res.status(200).json({ success: true, message: 'Posisi servo tersimpan' });
    } catch (err) {
        console.error('[/api/servo] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================================================
// ENDPOINT 3: ESP32 mengecek perintah manual dari dashboard
// GET /api/command
// =============================================================================
app.get('/api/command', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from(TABLE_COMMANDS)
            .select('*')
            .eq('is_executed', false)
            .order('created_at', { ascending: true })
            .limit(1);

        if (error) {
            // Tabel belum dibuat → kembalikan null agar ESP32 tidak crash
            if (error.code === 'PGRST116' || error.message.includes('schema cache')) {
                console.warn('[/api/command] Tabel system_commands belum ada di DB, kembalikan null.');
                return res.status(200).json({ success: true, command: null });
            }
            throw error;
        }

        if (data && data.length > 0) {
            res.status(200).json({ success: true, command: data[0] });
        } else {
            res.status(200).json({ success: true, command: null });
        }
    } catch (err) {
        console.error('[/api/command] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================================================
// ENDPOINT 3: ESP32 menandai perintah sudah dieksekusi
// POST /api/command/mark-executed
// =============================================================================
app.post('/api/command/mark-executed', async (req, res) => {
    try {
        const { command_id } = req.body;
        if (!command_id) {
            return res.status(400).json({ success: false, error: 'command_id diperlukan' });
        }

        const { error } = await supabase
            .from(TABLE_COMMANDS)
            .update({ is_executed: true })
            .eq('id', command_id);

        if (error) throw error;
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('[/api/command/mark-executed] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================================================
// ENDPOINT 4: Health check — cek koneksi backend ke Supabase
// GET /api/health
// =============================================================================
app.get('/api/health', async (req, res) => {
    try {
        const { error } = await supabase
            .from(TABLE_READINGS)
            .select('id')
            .limit(1);

        if (error) throw error;
        res.status(200).json({ success: true, message: 'Backend & Supabase Online' });
    } catch (err) {
        console.error('[/api/health] Supabase connection failed:', err.message);
        res.status(500).json({ success: false, error: 'Database disconnected' });
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
        res.status(200).json({ success: true, data: data || null });
    } catch (err) {
        console.error('[/api/latest] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(port, () => {
    console.log(`\n🌞 IoT Solar Tracker Backend`);
    console.log(`   Server   : http://localhost:${port}`);
    console.log(`   Supabase : ${supabaseUrl.replace('https://', '').split('.')[0]}...supabase.co`);
    console.log(`   API Key  : ${API_SECRET_KEY.slice(0, 8)}...`);
    console.log(`   Status   : Running ✓\n`);
});
