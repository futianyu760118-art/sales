const r = require('./routes/order-analysis');
r.stack.forEach((layer, i) => {
  if (layer.route) {
    const methods = Object.keys(layer.route.methods).map(m => m.toUpperCase()).join(',');
    console.log(i + ': ' + methods + ' ' + layer.route.path);
  } else if (layer.name === 'router') {
    console.log(i + ': [sub-router] ' + (layer.regexp && layer.regexp.source));
  } else {
    console.log(i + ': [middleware] ' + layer.name);
  }
});