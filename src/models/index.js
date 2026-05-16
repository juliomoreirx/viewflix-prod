// src/models/index.js
const User = require('./user.model');
const PurchasedContent = require('./purchased-content.model');
const BatchDownload = require('./batch-download.model'); // Apaga esta linha se apagares o ficheiro
const LiveTvBufferProfile = require('./livetv-buffer-profile.model');

module.exports = { 
  User, 
  PurchasedContent, 
  BatchDownload, // Apaga esta linha se apagares o ficheiro
  LiveTvBufferProfile 
};