module.exports = {
  apps: [
    {
      name: 'fasttv',
      script: './server.js',
      instances: 'max', // Use maximum available CPUs
      exec_mode: 'cluster', // Enables clustering mode
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};