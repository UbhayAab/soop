const http = require('http');
const fs = require('fs');
http.createServer((req, res) => {
  if (req.url === '/') {
    fs.readFile('index.html', (e, d) => {
      if (e) res.end('404');
      else res.end(d);
    });
  } else if (req.url.includes('.js')) {
    fs.readFile('.' + req.url, (e, d) => {
      if (e) res.end('404');
      else res.end(d);
    });
  } else {
    res.end('');
  }
}).listen(4321, () => console.log('http://127.0.0.1:4321'));