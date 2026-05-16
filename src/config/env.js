// src/config/env.js
require('dotenv').config();
const { z } = require('zod');

const envSchema = z.object({
  // Ambiente e Servidor
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.string().optional(),
  PORT: z.coerce.number().default(3000), // Converte string "3000" para número 3000
  DOMINIO_PUBLICO: z.string().default('http://localhost:3000'),
  SERVER_BASE_URL: z.string().default(':3000'),

  // Banco de Dados e Redis
  MONGO_URI: z.string().min(10),
  REDIS_URI: z.string().default('redis://localhost:6379'),

  // Autenticação e Segredos
  JWT_SECRET: z.string().min(10),
  SIGNED_SECRET: z.string().optional(),
  SIGNED_URL_SECRET: z.string().min(10).optional(),
  RELAY_SECRET: z.string().min(10).optional(),
  SIGNED_URL_TTL: z.coerce.number().default(120),

  // Credenciais de Provedores
  LOGIN_USER: z.string().min(1),
  LOGIN_PASS: z.string().min(1),

  // URLs Base
  BASE_URL: z.string().default('http://vouver.me'),
  VIDEO_BASE: z.string().default('http://goplay.icu/series'),
  MOVIE_BASE: z.string().default('http://goplay.icu/movie'),

  // Cloudflare e Proxies
  CLOUDFLARE_WORKER_URL: z.string().optional(),
  WORKER_CACHE_ENABLED: z.coerce.boolean().default(true), // string "true" vira boolean
  CF_CLEARANCE: z.string().optional(),
  CF_CLEARANCE_FALLBACK: z.string().optional(),
  SESSION_COOKIES: z.string().optional(),
  COOKIE_REFRESH_API_KEY: z.string().optional(),

  RES_PROXY_ENABLED: z.coerce.boolean().default(false),
  RES_PROXY_HOST: z.string().optional(),
  RES_PROXY_PORT: z.coerce.number().optional(),
  RES_PROXY_USER: z.string().optional(),
  RES_PROXY_PASS: z.string().optional(),

  // Telegram Bot e Pagamentos
  BOT_TOKEN: z.string().min(5),
  MP_ACCESS_TOKEN: z.string().optional(),
  
  PRECO_POR_HORA: z.coerce.number().default(250),
  PRECO_MINIMO: z.coerce.number().default(25),
  PRECO_MINIMO_SERIE: z.coerce.number().default(10),
  PRECO_LIVETV_FIXO: z.coerce.number().default(500),

  // Admins: Transforma "123,456" em array [123, 456]
  ADMIN_API_TOKEN: z.string().optional(),
  ADMIN_IDS: z.string().optional().transform(val => 
    val ? val.split(',').map(v => parseInt(v.trim(), 10)).filter(n => !isNaN(n)) : []
  ),

  // Bunny CDN
  BUNNY_STORAGE_KEY: z.string().optional(),
  BUNNY_STORAGE_NAME: z.string().optional(),
  BUNNY_PULL_ZONE_URL: z.string().optional(),
  BUNNY_PULL_ZONE_KEY: z.string().optional(),
  BUNNY_TEMP_DIR: z.string().default('/tmp/viewflix-cache'),
  BUNNY_CACHE_CONCURRENCY: z.coerce.number().default(2),
  BUNNY_CACHE_DEBUG: z.coerce.boolean().default(false),
  BUNNY_CACHE_RETRIES: z.coerce.number().default(2),
  BUNNY_CACHE_STALL_MS: z.coerce.number().default(90000),
  BUNNY_UPLOAD_USE_CURL: z.coerce.boolean().default(true),
  BUNNY_DOWNLOAD_USE_CURL: z.coerce.boolean().default(true),

  // HLS
  ENABLE_HLS_TRANSCODE: z.coerce.boolean().default(true),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFMPEG_TIMEOUT_MS: z.coerce.number().default(1800000),
  FFMPEG_TIMEOUT_FACTOR_MS_PER_SEC: z.coerce.number().default(4000),
  HLS_PROXY_ENCRYPTION_KEY: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Erro CRÍTICO de configuração no .env:');
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

module.exports = parsed.data;