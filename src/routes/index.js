const express = require('express');
const healthRoutes = require('./health.routes');
const streamRoutes = require('./stream.routes');
const secureStreamRoutes = require('./secure-stream.routes');
const catalogRoutes = require('./catalog.routes');
const authRoutes = require('./auth.routes');
const adminRoutes = require('./admin.routes');
const paymentsRoutes = require('./payments.routes');
const playerRoutes = require('./player.routes');



const router = express.Router();

router.use(healthRoutes);
router.use(streamRoutes);
router.use(secureStreamRoutes);
router.use(catalogRoutes);
router.use(authRoutes);
router.use(adminRoutes);
router.use(paymentsRoutes);
router.use('/', playerRoutes);

module.exports = router;