'use strict';

const http = require('node:http');
const path = require('node:path');

// Passenger may start from a different working directory.
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('./index.js');

http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Karutake process is running. Check the application logs for Discord login status.\n');
}).listen(process.env.PORT || 3000);
