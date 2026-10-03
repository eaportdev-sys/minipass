const port = process.env.PORT || 3000;
require('http').createServer((req, res) => {
  res.end('node app ok. DB: ' + (process.env.DATABASE_URL || process.env.DB_HOST || 'none'));
}).listen(port, () => console.log('listening ' + port));
