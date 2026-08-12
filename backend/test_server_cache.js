const http = require('http');
http.get('http://localhost:3010/api/order-analysis?page=1&limit=1', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const r = JSON.parse(d);
      console.log('total:', r.total);
      if (r.data && r.data.length > 0) {
        const first = r.data[0];
        console.log('第一个订单:', first.order_no);
        console.log('计划成本:', first.plan_total_cost);
        console.log('采购确认成本:', first.purchase_confirm_cost);
        console.log('计划物料成本:', first.plan_material_cost);
      }
    } catch (e) {
      console.log('解析失败:', e.message);
    }
  });
});
