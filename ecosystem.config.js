module.exports = {
  apps: [
    {
      name: 'fasttv',
      script: './server.js',
      instances: 1, // Single instance required for Telegram bot polling
      exec_mode: 'fork', // Disables clustering mode to prevent polling conflicts
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};