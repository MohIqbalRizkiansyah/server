import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || 'placeholder_service_key';
const supabase = createClient(supabaseUrl, supabaseKey);

console.log("Checking Supabase Connection...");
console.log("URL:", supabaseUrl);

async function testConnection() {
    try {
        const { data, error } = await supabase
            .from('readings')
            .select('id')
            .limit(1);

        if (error) {
            console.error("❌ KONEKSI GAGAL!");
            console.error(error);
            process.exit(1);
        }
        
        console.log("✅ KONEKSI BERHASIL! Backend dapat berkomunikasi dengan Supabase.");
        process.exit(0);
    } catch (err) {
        console.error("❌ ERROR KONEKSI:");
        console.error(err);
        process.exit(1);
    }
}

testConnection();
