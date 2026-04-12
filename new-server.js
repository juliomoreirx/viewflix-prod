require('dotenv').config();
const { startServer } = require('./src/bootstrap/server-bootstrap');

startServer().catch((err) => {
  console.error('Falha ao iniciar:', err);
  process.exit(1);
});