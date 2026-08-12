const http = require('http');

// 直接测试作废API
const req = http.request({
  hostname: 'localhost',
  port: 3010,
  path: '/api/order-analysis/890/void',
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', 'x-user-id': '1' }
}, (res) => {
  console.log('status:', res.statusCode);
  console.log('headers:', JSON.stringify(res.headers));
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('body:', d);
  });
});
req.write(JSON.stringify({ is_void: true }));
req.end();
