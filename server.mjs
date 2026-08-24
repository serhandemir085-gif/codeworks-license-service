import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const port = Number(process.env.PORT || 10000);
const adminKey = process.env.ADMIN_KEY;
let pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 }) : null;
const memory = new Map();
const publicDir = path.join(process.cwd(), "public");

function key() { const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const part = size => Array.from({ length: size }, () => alphabet[crypto.randomInt(alphabet.length)]).join(""); return `${part(5)}-${part(4)}-${part(4)}-${part(4)}`; }
function json(response, status, data) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(data)); }
async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
async function staticFile(response, fileName, contentType) { try { const data = await readFile(path.join(publicDir, fileName)); response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" }); response.end(data); } catch { json(response, 404, { error: "Not found" }); } }
async function init() {
  if (!pool) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS licenses (license_key text PRIMARY KEY, expires_at timestamptz, duration_days integer NOT NULL DEFAULT 30, unlimited boolean NOT NULL DEFAULT false, activated_at timestamptz, device_id text, revoked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), note text)`);
    await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS duration_days integer NOT NULL DEFAULT 30`);
    await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS unlimited boolean NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS activated_at timestamptz`);
    await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS device_id text`);
    await pool.query(`ALTER TABLE licenses ALTER COLUMN expires_at DROP NOT NULL`);
  } catch (error) {
    console.error(`Database unavailable; using in-memory storage: ${error.message}`);
    await pool.end().catch(() => {});
    pool = null;
  }
}
async function getLicense(licenseKey) { if (pool) return (await pool.query("SELECT * FROM licenses WHERE license_key=$1", [licenseKey])).rows[0]; return memory.get(licenseKey); }
async function listLicenses() { if (pool) return (await pool.query("SELECT license_key, expires_at, duration_days, unlimited, activated_at, device_id IS NOT NULL AS device_bound, revoked, created_at, note FROM licenses ORDER BY created_at DESC")).rows; return [...memory.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)); }
async function createLicense(days, note) { const licenseKey = key(); const duration = Math.max(1, Number(days || 30)); const record = { license_key: licenseKey, expires_at: null, duration_days: duration, unlimited: false, activated_at: null, device_id: null, revoked: false, created_at: new Date().toISOString(), note: note || "" }; if (pool) await pool.query("INSERT INTO licenses(license_key, expires_at, duration_days, unlimited, activated_at, device_id, note) VALUES($1,NULL,$2,false,NULL,NULL,$3)", [licenseKey, duration, record.note]); else memory.set(licenseKey, record); return record; }
async function createLicenses(count, days, note) { const result = []; for (let i = 0; i < Math.min(1000, Math.max(1, Number(count || 1))); i++) result.push(await createLicense(days, note)); return result; }
async function activateLicense(item, deviceId) { const activated = new Date(); const expires = item.unlimited ? null : new Date(activated.getTime() + Math.max(1, Number(item.duration_days || 30)) * 86400000); if (pool) await pool.query("UPDATE licenses SET activated_at=$1, expires_at=$2, device_id=$3 WHERE license_key=$4 AND activated_at IS NULL", [activated, expires, deviceId, item.license_key]); else { item.activated_at = activated.toISOString(); item.expires_at = expires?.toISOString() || null; item.device_id = deviceId; } item.activated_at = item.activated_at || activated.toISOString(); item.expires_at = item.expires_at || expires?.toISOString() || null; item.device_id = item.device_id || deviceId; return item; }
async function updateLicense(licenseKey, input) {
  const days = Number(input.days || 0);
  if (!Number.isInteger(days) || days < -3650 || days > 3650) throw new Error("Gün değeri -3650 ile 3650 arasında olmalı.");
  if (pool) {
    if (input.reactivate === true) await pool.query("UPDATE licenses SET revoked=false WHERE license_key=$1", [licenseKey]);
    if (days !== 0) await pool.query("UPDATE licenses SET duration_days=GREATEST(1, duration_days+$1), expires_at=CASE WHEN expires_at IS NULL THEN NULL ELSE expires_at + ($1 * interval '1 day') END WHERE license_key=$2", [days, licenseKey]);
    return getLicense(licenseKey);
  }
  const item = memory.get(licenseKey); if (!item) return null;
  if (input.reactivate === true) item.revoked = false;
  if (days !== 0) { item.duration_days = Math.max(1, item.duration_days + days); if (item.expires_at) item.expires_at = new Date(new Date(item.expires_at).getTime() + days * 86400000).toISOString(); }
  return item;
}
async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === "GET" && url.pathname === "/") return staticFile(response, "index.html", "text/html; charset=utf-8");
  if (url.pathname === "/health") return json(response, 200, { ok: true, service: "CodeWorks License" });
  if (url.pathname === "/v1/licenses/validate" && request.method === "POST") {
    const input = await body(request); const deviceId = String(input.deviceId || "").trim();
    const item = await getLicense(String(input.licenseKey || "").trim().toUpperCase());
    if (!item || item.revoked) return json(response, 403, { valid: false, error: "Lisans geçersiz veya iptal edilmiş." });
    if (item.device_id && item.device_id !== deviceId) return json(response, 403, { valid: false, error: "Bu lisans başka bir cihaza bağlı." });
    if (!item.activated_at || (!item.unlimited && !item.expires_at)) await activateLicense(item, deviceId);
    if (!item.unlimited && new Date(item.expires_at) <= new Date()) return json(response, 403, { valid: false, error: "Lisans süresi dolmuş." });
    return json(response, 200, { valid: true, licenseKey: item.license_key, activatedAt: item.activated_at, expiresAt: item.expires_at, deviceBound: true, token: crypto.createHmac("sha256", process.env.TOKEN_SECRET || "change-me").update(item.license_key + item.expires_at + item.device_id).digest("hex") });
  }
  if (!url.pathname.startsWith("/admin/api/")) return json(response, 404, { error: "Not found" });
  if (!adminKey || request.headers.authorization !== `Bearer ${adminKey}`) return json(response, 401, { error: "Unauthorized" });
  if (url.pathname === "/admin/api/licenses" && request.method === "GET") return json(response, 200, await listLicenses());
  if (url.pathname === "/admin/api/licenses/generate" && request.method === "POST") { const input = await body(request); const records = await createLicenses(input.count || 1, input.days, input.note); return json(response, 201, input.count > 1 ? { licenses: records } : records[0]); }
  const update = url.pathname.match(/^\/admin\/api\/licenses\/([^/]+)\/update$/); if (update && request.method === "POST") { const input = await body(request); const item = await updateLicense(decodeURIComponent(update[1]), input); return item ? json(response, 200, item) : json(response, 404, { error: "License not found" }); }
  const revoke = url.pathname.match(/^\/admin\/api\/licenses\/([^/]+)\/revoke$/); if (revoke && request.method === "POST") { const licenseKey = decodeURIComponent(revoke[1]); if (pool) await pool.query("UPDATE licenses SET revoked=true WHERE license_key=$1", [licenseKey]); else if (memory.has(licenseKey)) memory.get(licenseKey).revoked = true; return json(response, 200, { ok: true, licenseKey }); }
  return json(response, 404, { error: "Not found" });
}
await init(); http.createServer((request, response) => route(request, response).catch(error => json(response, 500, { error: error.message }))).listen(port, "0.0.0.0");
