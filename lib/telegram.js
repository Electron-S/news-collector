'use strict';

require('dotenv').config();
const https = require('https');
const axios = require('axios');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const http = axios.create({ httpsAgent: new https.Agent({ family: 4 }), timeout: 15000 });

module.exports = { TOKEN, CHAT_ID, http };
