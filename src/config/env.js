const { z } = require('zod');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.string().default('3000'),
  DOMINIO_PUBLICO: z.string().default('http://localhost:3000'),

  JWT_SECRET: z.string().min(10),
  SIGNED_URL_SECRET: z.string().min(10),
  RELAY_SECRET: z.string().min(10),

  MONGO_URI: z.string().min(10),

  LOGIN_USER: z.string().min(1),
  LOGIN_PASS: z.string().min(1),

  BASE_URL: z.string().default('http://vouver.me'),
  VIDEO_BASE: z.string().default('http://goplay.icu/series'),
  MOVIE_BASE: z.string().default('http://goplay.icu/movie'),

  CLOUDFLARE_WORKER_URL: z.string().optional(),
  CF_CLEARANCE: z.string().optional(),
  SESSION_COOKIES: z.string().optional(),

  RES_PROXY_ENABLED: z.string().optional(),
  RES_PROXY_HOST: z.string().optional(),
  RES_PROXY_PORT: z.string().optional(),
  RES_PROXY_USER: z.string().optional(),
  RES_PROXY_PASS: z.string().optional(),

  MP_ACCESS_TOKEN: z.string().optional(),
  ADMIN_API_TOKEN: z.string().optional(),

  REDIS_URI: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Erro de configuração .env:', parsed.error.format());
  process.exit(1);
}

module.exports = parsed.data;