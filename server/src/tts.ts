import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import type { User } from "./auth.js";

// Voiceover for the learning phase. The ElevenLabs key stays on the server; the browser asks this route for audio.
// If ElevenLabs is unavailable (no key, quota used up, error), the route answers 503 {fallback:true} and the
// browser reads the text with the operating system's own voice instead (Windows voices on Windows).

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "Xb7hH8MSUJpSbSDYk0k2"; // "Alice, Clear, Engaging Educator" (a free-plan premade voice)
const MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5"; // low latency, half the character cost of the multilingual models
const CACHE_DIR = path.resolve("data", "tts");
const MAX_CHARS = 500;
const PER_USER_CHARS_PER_HOUR = Number(process.env.TTS_USER_CHARS_PER_HOUR || 2500);

let pausedUntil = 0; // after a quota or auth failure, stop calling ElevenLabs for a while
let pausedReason = "";
const usage = new Map<number, { start: number; chars: number }>();
let quotaCache: { at: number; used: number; limit: number; tier: string } | null = null;

const apiKey = () => process.env.ELEVENLABS_API_KEY || "";
const cachePath = (text: string) =>
  path.join(CACHE_DIR, crypto.createHash("sha1").update(`${VOICE_ID}|${MODEL}|${text}`).digest("hex") + ".mp3");

async function quota() {
  if (!apiKey()) return null;
  if (quotaCache && Date.now() - quotaCache.at < 60_000) return quotaCache;
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": apiKey() }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    quotaCache = { at: Date.now(), used: j.character_count, limit: j.character_limit, tier: j.tier };
    return quotaCache;
  } catch { return null; }
}

export function registerTtsRoutes(app: Express, authed: (req: Request, res: Response) => User | null) {
  app.get("/api/coach/tts/status", async (req, res) => {
    if (!authed(req, res)) return;
    const q = await quota();
    const live = !!apiKey() && Date.now() >= pausedUntil && (!q || q.used < q.limit);
    res.json({ elevenlabs: live, configured: !!apiKey(), reason: live ? null : !apiKey() ? "no key" : pausedReason || "quota used up", charsLeft: q ? Math.max(0, q.limit - q.used) : null, tier: q?.tier ?? null });
  });

  app.post("/api/coach/tts", async (req, res) => {
    const user = authed(req, res);
    if (!user) return;
    const text = String(req.body?.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
    if (!text) return void res.status(400).json({ error: "No text" });
    const file = cachePath(text);
    if (fs.existsSync(file)) { // repeated phrases cost nothing
      res.type("audio/mpeg").set("x-voice", "elevenlabs-cache").send(fs.readFileSync(file));
      return;
    }
    const fallback = (reason: string) => res.status(503).json({ fallback: true, reason });
    if (!apiKey()) return void fallback("no key");
    if (Date.now() < pausedUntil) return void fallback(pausedReason);
    const now = Date.now();
    const u = usage.get(user.id);
    const bucket = u && now - u.start < 3_600_000 ? u : { start: now, chars: 0 };
    if (bucket.chars + text.length > PER_USER_CHARS_PER_HOUR) return void fallback("hourly voice limit reached");
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_64`, {
        method: "POST",
        headers: { "xi-api-key": apiKey(), "content-type": "application/json" },
        body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        if (r.status === 401 || r.status === 402 || r.status === 429 || /quota/i.test(body)) {
          pausedUntil = Date.now() + (r.status === 401 ? 3_600_000 : 600_000);
          pausedReason = r.status === 401 ? "key rejected" : "quota or plan limit";
          console.warn(`tts: ElevenLabs ${r.status}, using the browser voice for a while`);
        }
        return void fallback(`ElevenLabs ${r.status}`);
      }
      const audio = Buffer.from(await r.arrayBuffer());
      bucket.chars += text.length;
      usage.set(user.id, bucket);
      quotaCache = null;
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, audio);
      res.type("audio/mpeg").set("x-voice", "elevenlabs").send(audio);
    } catch (e: any) {
      fallback(e?.name === "TimeoutError" ? "ElevenLabs timed out" : "ElevenLabs unreachable");
    }
  });
}
