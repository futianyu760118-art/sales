const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

// 仪表盘概览统计
router.get('/summary', requirePerm('report:view'), (req, res) => {
  const { start_date, end_date } = req.query;
  const table = getTable('inquiries');
  const filter = (r) => {
    if (start_date && r.inquiry_time < start_date) return false;
    if (end_date && r.inquiry_time > end_date) return false;
    return true;
  };
  const records = table.all().filter(filter);

  const summary = {
    total: records.length,
    new_count: records.filter(r => r.status === 'new').length,
    pending_pricing_count: records.filter(r => r.status === 'pending_pricing' || r.status === 'pending_quote').length,
    quoted_count: records.filter(r => r.status === 'quoted' || r.status === 'negotiating').length,
    sample_count: records.filter(r => r.status === 'sample' || r.status === 'project').length,
    lost_count: records.filter(r => r.status === 'lost').length,
    closed_count: records.filter(r => r.status === 'closed').length,
    total_amount: records.reduce((sum, r) => sum + (r.final_price || 0), 0),
    closed_amount: records.filter(r => r.status === 'closed').reduce((sum, r) => sum + (r.final_price || 0), 0)
  };
  // 转化率
  summary.conversion_rate = summary.total > 0 ? Math.round(summary.closed_count / summary.total * 10000) / 100 : 0;
  // 流失率
  summary.lost_rate = summary.total > 0 ? Math.round(summary.lost_count / summary.total * 10000) / 100 : 0;
  res.json(summary);
});

// 销售人员业绩统计（增强版：含时效数据）
router.get('/sales-performance', requirePerm('report:view'), (req, res) => {
  const { start_date, end_date } = req.query;
  const table = getTable('inquiries');
  const filter = (r) => {
    if (start_date && r.inquiry_time < start_date) return false;
    if (end_date && r.inquiry_time > end_date) return false;
    return true;
  };
  const records = table.all().filter(filter);

  const grouped = {};
  records.forEach(r => {
    const person = r.sales_person || '未分配';
    if (!grouped[person]) {
      grouped[person] = {
        sales_person: person, total_inquiries: 0, quoted_count: 0, sample_count: 0,
        closed_count: 0, lost_count: 0, total_amount: 0, closed_amount: 0,
        // 时效数据
        pricing_times: [], // 核价耗时(小时)
        quote_times: [],   // 报价耗时(小时)
        follow_up_count: 0 // 跟进次数
      };
    }
    grouped[person].total_inquiries++;
    if (r.status === 'quoted' || r.status === 'negotiating') grouped[person].quoted_count++;
    if (r.status === 'sample' || r.status === 'project') grouped[person].sample_count++;
    if (r.status === 'closed') { grouped[person].closed_count++; grouped[person].closed_amount += (r.final_price || 0); }
    if (r.status === 'lost') grouped[person].lost_count++;
    grouped[person].total_amount += (r.final_price || 0);

    // 计算报价时效
    if (r.quoted_at && r.created_at) {
      const created = new Date(r.created_at);
      const quoted = new Date(r.quoted_at);
      const hours = (quoted - created) / (1000 * 60 * 60);
      if (hours >= 0) grouped[person].quote_times.push(hours);
    }
  });

  // 统计跟进次数
  const commentTable = getTable('inquiry_comments');
  const comments = commentTable.all();
  comments.forEach(c => {
    const inq = records.find(r => r.id === c.inquiry_id);
    if (inq && grouped[inq.sales_person]) {
      grouped[inq.sales_person].follow_up_count++;
    }
  });

  // 计算转化率和平均时效
  const result = Object.values(grouped).map(g => ({
    ...g,
    conversion_rate: g.total_inquiries > 0 ? Math.round(g.closed_count / g.total_inquiries * 10000) / 100 : 0,
    lost_rate: g.total_inquiries > 0 ? Math.round(g.lost_count / g.total_inquiries * 10000) / 100 : 0,
    avg_quote_time: g.quote_times.length > 0 ? Math.round(g.quote_times.reduce((a, b) => a + b, 0) / g.quote_times.length * 10) / 10 : null,
    sample_rate: g.total_inquiries > 0 ? Math.round(g.sample_count / g.total_inquiries * 10000) / 100 : 0
  }));

  res.json(result);
});

// 人员考核数据（独立考核闭环）
router.get('/performance-assessment', requirePerm('report:view'), (req, res) => {
  const { start_date, end_date } = req.query;
  const table = getTable('inquiries');
  const filter = (r) => {
    if (start_date && r.inquiry_time < start_date) return false;
    if (end_date && r.inquiry_time > end_date) return false;
    return true;
  };
  const records = table.all().filter(filter);

  const grouped = {};
  records.forEach(r => {
    const person = r.sales_person || '未分配';
    if (!grouped[person]) {
      grouped[person] = {
        sales_person: person,
        total_inquiries: 0,
        quoted_count: 0,
        closed_count: 0,
        lost_count: 0,
        sample_count: 0,
        quote_times: [],
        follow_up_count: 0,
        lost_reasons: []
      };
    }
    grouped[person].total_inquiries++;
    if (['quoted', 'negotiating'].includes(r.status)) grouped[person].quoted_count++;
    if (r.status === 'closed') grouped[person].closed_count++;
    if (r.status === 'lost') {
      grouped[person].lost_count++;
      if (r.lost_reason) grouped[person].lost_reasons.push(r.lost_reason);
    }
    if (['sample', 'project'].includes(r.status)) grouped[person].sample_count++;

    if (r.quoted_at && r.created_at) {
      const hours = (new Date(r.quoted_at) - new Date(r.created_at)) / (1000 * 60 * 60);
      if (hours >= 0) grouped[person].quote_times.push(hours);
    }
  });

  // 跟进次数
  const commentTable = getTable('inquiry_comments');
  commentTable.all().forEach(c => {
    const inq = records.find(r => r.id === c.inquiry_id);
    if (inq && grouped[inq.sales_person]) {
      grouped[inq.sales_person].follow_up_count++;
    }
  });

  // 计算考核指标
  const result = Object.values(grouped).map(g => {
    const avgQuoteTime = g.quote_times.length > 0
      ? Math.round(g.quote_times.reduce((a, b) => a + b, 0) / g.quote_times.length * 10) / 10 : null;

    // 处理及时率：24小时内报价的比例
    const timelyCount = g.quote_times.filter(t => t <= 24).length;
    const timelyRate = g.quote_times.length > 0 ? Math.round(timelyCount / g.quote_times.length * 10000) / 100 : 0;

    // 转化率
    const conversionRate = g.total_inquiries > 0 ? Math.round(g.closed_count / g.total_inquiries * 10000) / 100 : 0;

    // 转样率
    const sampleRate = g.total_inquiries > 0 ? Math.round(g.sample_count / g.total_inquiries * 10000) / 100 : 0;

    // 流失率
    const lostRate = g.total_inquiries > 0 ? Math.round(g.lost_count / g.total_inquiries * 10000) / 100 : 0;

    // 短板分析
    const weaknesses = [];
    if (timelyRate < 80) weaknesses.push('报价响应慢');
    if (conversionRate < 20) weaknesses.push('成交转化低');
    if (lostRate > 30) weaknesses.push('流失率偏高');
    if (g.follow_up_count < g.total_inquiries * 0.5) weaknesses.push('跟进不足');

    // 培训建议
    const trainingNeeds = [];
    if (timelyRate < 80) trainingNeeds.push('报价流程优化培训');
    if (conversionRate < 20) trainingNeeds.push('销售谈判技巧培训');
    if (lostRate > 30) trainingNeeds.push('客户需求分析培训');
    if (g.follow_up_count < g.total_inquiries * 0.5) trainingNeeds.push('客户跟进规范培训');

    return {
      sales_person: g.sales_person,
      total_inquiries: g.total_inquiries,
      closed_count: g.closed_count,
      lost_count: g.lost_count,
      sample_count: g.sample_count,
      avg_quote_time_hours: avgQuoteTime,
      timely_rate: timelyRate,
      conversion_rate: conversionRate,
      sample_rate: sampleRate,
      lost_rate: lostRate,
      follow_up_count: g.follow_up_count,
      lost_reasons: g.lost_reasons,
      weaknesses,
      training_needs: trainingNeeds
    };
  });

  res.json(result);
});

// 报价时效统计
router.get('/quote-timing', requirePerm('report:view'), (req, res) => {
  const { start_date, end_date } = req.query;
  const table = getTable('inquiries');
  const filter = (r) => {
    if (start_date && r.inquiry_time < start_date) return false;
    if (end_date && r.inquiry_time > end_date) return false;
    return r.quoted_at && r.created_at;
  };
  const records = table.all().filter(filter);

  const timingData = records.map(r => {
    const hours = (new Date(r.quoted_at) - new Date(r.created_at)) / (1000 * 60 * 60);
    return {
      id: r.id,
      serial_number: r.serial_number,
      customer_name: r.customer_name,
      sales_person: r.sales_person,
      created_at: r.created_at,
      quoted_at: r.quoted_at,
      quote_time_hours: Math.round(hours * 10) / 10,
      is_timely: hours <= 24
    };
  });

  const avgTime = timingData.length > 0
    ? Math.round(timingData.reduce((s, t) => s + t.quote_time_hours, 0) / timingData.length * 10) / 10 : 0;
  const timelyCount = timingData.filter(t => t.is_timely).length;
  const timelyRate = timingData.length > 0 ? Math.round(timelyCount / timingData.length * 10000) / 100 : 0;

  res.json({
    total: timingData.length,
    avg_quote_time_hours: avgTime,
    timely_count: timelyCount,
    timely_rate: timelyRate,
    details: timingData.sort((a, b) => a.quote_time_hours - b.quote_time_hours)
  });
});

// 客户来源分析
router.get('/customer-source', requirePerm('report:view'), (req, res) => {
  const table = getTable('customers');
  const customers = table.all();
  const inqTable = getTable('inquiries');
  const inquiries = inqTable.all();

  const grouped = {};
  customers.forEach(c => {
    const source = c.source || '未知';
    if (!grouped[source]) {
      grouped[source] = { source, customer_count: 0, inquiry_count: 0, closed_count: 0, closed_amount: 0 };
    }
    grouped[source].customer_count++;
  });
  inquiries.forEach(i => {
    const source = i.customer_source || '未知';
    if (grouped[source]) {
      grouped[source].inquiry_count++;
      if (i.status === 'closed') {
        grouped[source].closed_count++;
        grouped[source].closed_amount += (i.final_price || 0);
      }
    }
  });

  res.json(Object.values(grouped));
});

// 产品类别统计
router.get('/product-category', requirePerm('report:view'), (req, res) => {
  const table = getTable('inquiries');
  const records = table.all();

  const grouped = {};
  records.forEach(r => {
    const cat = r.product_category || '未分类';
    if (!grouped[cat]) {
      grouped[cat] = { category: cat, inquiry_count: 0, total_amount: 0, closed_count: 0 };
    }
    grouped[cat].inquiry_count++;
    grouped[cat].total_amount += (r.final_price || 0);
    if (r.status === 'closed') grouped[cat].closed_count++;
  });

  res.json(Object.values(grouped));
});

// 月度趋势
router.get('/monthly-trend', requirePerm('report:view'), (req, res) => {
  const { year } = req.query;
  const table = getTable('inquiries');
  const records = table.all();

  if (year) {
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const monthKey = `${year}-${String(m).padStart(2, '0')}`;
      const monthRecords = records.filter(r => r.inquiry_time && r.inquiry_time.startsWith(monthKey));
      months.push({
        month: monthKey,
        inquiry_count: monthRecords.length,
        quoted_count: monthRecords.filter(r => ['quoted', 'negotiating', 'sample', 'project', 'closed'].includes(r.status)).length,
        closed_count: monthRecords.filter(r => r.status === 'closed').length,
        closed_amount: monthRecords.filter(r => r.status === 'closed').reduce((s, r) => s + (r.final_price || 0), 0)
      });
    }
    res.json(months);
  } else {
    const grouped = {};
    records.forEach(r => {
      if (!r.inquiry_time) return;
      const monthKey = r.inquiry_time.substring(0, 7);
      if (!grouped[monthKey]) {
        grouped[monthKey] = { month: monthKey, inquiry_count: 0, quoted_count: 0, closed_count: 0, closed_amount: 0 };
      }
      grouped[monthKey].inquiry_count++;
      if (['quoted', 'negotiating', 'sample', 'project', 'closed'].includes(r.status)) grouped[monthKey].quoted_count++;
      if (r.status === 'closed') {
        grouped[monthKey].closed_count++;
        grouped[monthKey].closed_amount += (r.final_price || 0);
      }
    });
    const result = Object.values(grouped).sort((a, b) => a.month.localeCompare(b.month));
    res.json(result);
  }
});

// 流失原因分析
router.get('/lost-reasons', requirePerm('report:view'), (req, res) => {
  const table = getTable('inquiries');
  const lostRecords = table.all().filter(r => r.status === 'lost');

  const grouped = {};
  lostRecords.forEach(r => {
    const reason = r.lost_reason || '未填写';
    if (!grouped[reason]) {
      grouped[reason] = { reason, count: 0, amount: 0, inquiries: [] };
    }
    grouped[reason].count++;
    grouped[reason].amount += (r.final_price || 0);
    grouped[reason].inquiries.push({
      id: r.id,
      serial_number: r.serial_number,
      customer_name: r.customer_name,
      external_model: r.external_model,
      final_price: r.final_price,
      sales_person: r.sales_person
    });
  });

  res.json(Object.values(grouped).sort((a, b) => b.count - a.count));
});

// PDCA改善闭环数据
router.get('/pdca', requirePerm('report:view'), (req, res) => {
  const table = getTable('inquiries');
  const records = table.all();

  // P: 问题发现 - 流失原因汇总、报价延迟统计
  const lostRecords = records.filter(r => r.status === 'lost');
  const lostReasons = {};
  lostRecords.forEach(r => {
    const reason = r.lost_reason || '未填写';
    lostReasons[reason] = (lostReasons[reason] || 0) + 1;
  });

  // 报价时效问题
  const quotedRecords = records.filter(r => r.quoted_at && r.created_at);
  const slowQuotes = quotedRecords.filter(r => {
    const hours = (new Date(r.quoted_at) - new Date(r.created_at)) / (1000 * 60 * 60);
    return hours > 24;
  });

  // D: 改善计划建议
  const improvementPlans = [];
  if (lostRecords.length > 0) {
    improvementPlans.push({
      issue: '询价流失',
      severity: 'high',
      suggestion: '加强客户需求分析，优化报价策略',
      affected_count: lostRecords.length
    });
  }
  if (slowQuotes.length > 0) {
    improvementPlans.push({
      issue: '报价响应慢',
      severity: 'high',
      suggestion: '优化核价流程，建立快速报价通道',
      affected_count: slowQuotes.length
    });
  }

  // C: 复盘指标
  const totalInquiries = records.length;
  const closedRecords = records.filter(r => r.status === 'closed');
  const conversionRate = totalInquiries > 0 ? Math.round(closedRecords.length / totalInquiries * 10000) / 100 : 0;
  const avgQuoteTime = quotedRecords.length > 0
    ? Math.round(quotedRecords.reduce((s, r) => s + (new Date(r.quoted_at) - new Date(r.created_at)) / (1000 * 60 * 60), 0) / quotedRecords.length * 10) / 10 : 0;

  // A: SOP沉淀建议
  const sopSuggestions = [];
  if (conversionRate < 30) sopSuggestions.push('建立标准报价SOP，统一报价口径');
  if (avgQuoteTime > 24) sopSuggestions.push('制定24小时报价响应规范');
  if (lostRecords.length > totalInquiries * 0.2) sopSuggestions.push('建立客户流失预警机制');

  res.json({
    problems: {
      lost_reasons: lostReasons,
      total_lost: lostRecords.length,
      slow_quote_count: slowQuotes.length,
      total_quoted: quotedRecords.length
    },
    improvement_plans: improvementPlans,
    review_metrics: {
      conversion_rate: conversionRate,
      avg_quote_time_hours: avgQuoteTime,
      lost_rate: totalInquiries > 0 ? Math.round(lostRecords.length / totalInquiries * 10000) / 100 : 0
    },
    sop_suggestions: sopSuggestions
  });
});

// 询价处理时效统计（看板用）
router.get('/inquiry-timing', requirePerm('report:view'), (req, res) => {
  const table = getTable('inquiries');
  const records = table.all();

  // 各状态停留时间统计
  const statusTable = getTable('inquiry_status_changes');
  const changes = statusTable.all();

  const timingByStatus = {};
  const statusOrder = ['new', 'pending_pricing', 'pending_quote', 'quoted', 'negotiating', 'sample', 'project', 'closed', 'lost'];

  statusOrder.forEach(status => {
    const statusChanges = changes.filter(c => c.status === status);
    if (statusChanges.length === 0) return;

    // 计算每个询价在该状态的停留时间
    const durations = [];
    statusChanges.forEach(sc => {
      const nextChange = changes.find(c => c.inquiry_id === sc.inquiry_id && new Date(c.changed_at) > new Date(sc.changed_at));
      if (nextChange) {
        const hours = (new Date(nextChange.changed_at) - new Date(sc.changed_at)) / (1000 * 60 * 60);
        if (hours >= 0) durations.push(hours);
      }
    });

    if (durations.length > 0) {
      timingByStatus[status] = {
        avg_hours: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length * 10) / 10,
        min_hours: Math.round(Math.min(...durations) * 10) / 10,
        max_hours: Math.round(Math.max(...durations) * 10) / 10,
        count: durations.length
      };
    }
  });

  res.json(timingByStatus);
});

// 操作日志
router.get('/operation-logs', requirePerm('report:view'), (req, res) => {
  const { limit = 20, action } = req.query;
  const table = getTable('operation_logs');
  let records = table.all().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  if (action) {
    records = records.filter(r => r.action === action);
  }
  res.json(records.slice(0, parseInt(limit)));
});

// ===== 数据穿透下钻：按状态查询明细 =====
router.get('/drill-by-status', requirePerm('report:view'), (req, res) => {
  const { status, start_date, end_date, page = 1, limit = 20 } = req.query;
  const table = getTable('inquiries');
  const filter = (r) => {
    if (status && r.status !== status) return false;
    if (start_date && r.inquiry_time < start_date) return false;
    if (end_date && r.inquiry_time > end_date) return false;
    return true;
  };
  const { records, total } = table.findWhere(filter, 'inquiry_time', 'DESC', parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

// ===== 数据穿透下钻：按月份查询明细 =====
router.get('/drill-by-month', requirePerm('report:view'), (req, res) => {
  const { month, start_date, end_date, page = 1, limit = 20 } = req.query;
  const table = getTable('inquiries');
  const filter = (r) => {
    if (month && (!r.inquiry_time || !r.inquiry_time.startsWith(month))) return false;
    if (start_date && r.inquiry_time < start_date) return false;
    if (end_date && r.inquiry_time > end_date) return false;
    return true;
  };
  const { records, total } = table.findWhere(filter, 'inquiry_time', 'DESC', parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

// ===== 数据穿透下钻：按销售查询明细 =====
router.get('/drill-by-sales', requirePerm('report:view'), (req, res) => {
  const { sales_person, status, start_date, end_date, page = 1, limit = 20 } = req.query;
  const table = getTable('inquiries');
  const filter = (r) => {
    if (sales_person && r.sales_person !== sales_person) return false;
    if (status && r.status !== status) return false;
    if (start_date && r.inquiry_time < start_date) return false;
    if (end_date && r.inquiry_time > end_date) return false;
    return true;
  };
  const { records, total } = table.findWhere(filter, 'inquiry_time', 'DESC', parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

// ===== 数据备份 =====
router.get('/backup', requirePerm('report:view'), (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const dataDir = path.join(__dirname, '../../database');
  const backup = {};
  const tableNames = ['users', 'products', 'customers', 'materials', 'pricing_standards',
    'inquiries', 'inquiry_status_changes', 'inquiry_comments', 'inquiry_messages',
    'operation_logs', 'samples', 'projects', 'orders'];
  tableNames.forEach(name => {
    const filePath = path.join(dataDir, name + '.json');
    if (fs.existsSync(filePath)) {
      try { backup[name] = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch(e) { backup[name] = null; }
    }
  });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  res.setHeader('Content-Disposition', `attachment; filename="backup_${timestamp}.json"`);
  res.json(backup);
});

// ===== 数据恢复 =====
router.post('/restore', requirePerm('report:view'), (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const dataDir = path.join(__dirname, '../../database');
  const backup = req.body;
  if (!backup || typeof backup !== 'object') {
    return res.status(400).json({ error: '无效的备份数据' });
  }
  let restored = 0;
  Object.keys(backup).forEach(name => {
    if (backup[name]) {
      const filePath = path.join(dataDir, name + '.json');
      fs.writeFileSync(filePath, JSON.stringify(backup[name], null, 2), 'utf8');
      restored++;
    }
  });
  // 清除缓存
  const { getTable } = require('../db');
  Object.keys(backup).forEach(name => {
    try { getTable(name)._invalidate(); } catch(e) {}
  });
  res.json({ message: `数据恢复完成，共恢复 ${restored} 张表`, restored });
});

// ===== 台账汇总统计 =====
router.get('/ledger-summary', requirePerm('report:view'), (req, res) => {
  const { start_date, end_date } = req.query;
  const table = getTable('inquiries');
  const filter = (r) => {
    if (start_date && r.inquiry_time < start_date) return false;
    if (end_date && r.inquiry_time > end_date) return false;
    return true;
  };
  const records = table.all().filter(filter);

  const summary = {
    total: records.length,
    total_material_cost: records.reduce((s, r) => s + (r.material_cost || 0), 0),
    total_process_cost: records.reduce((s, r) => s + (r.process_cost || 0), 0),
    total_accessory_cost: records.reduce((s, r) => s + (r.accessory_cost || 0), 0),
    total_estimated_loss: records.reduce((s, r) => s + (r.estimated_loss || 0), 0),
    total_base_cost: records.reduce((s, r) => s + (r.base_cost || 0), 0),
    total_final_price: records.reduce((s, r) => s + (r.final_price || 0), 0),
    avg_profit_rate: records.filter(r => r.profit_rate > 0).length > 0
      ? Math.round(records.filter(r => r.profit_rate > 0).reduce((s, r) => s + r.profit_rate, 0) / records.filter(r => r.profit_rate > 0).length * 10000) / 100 : 0,
    avg_discount_rate: records.filter(r => r.discount_rate > 0).length > 0
      ? Math.round(records.filter(r => r.discount_rate > 0).reduce((s, r) => s + r.discount_rate, 0) / records.filter(r => r.discount_rate > 0).length * 10000) / 100 : 0,
    by_status: {},
    by_category: {}
  };

  // 按状态汇总
  records.forEach(r => {
    const st = r.status || 'unknown';
    if (!summary.by_status[st]) summary.by_status[st] = { count: 0, amount: 0 };
    summary.by_status[st].count++;
    summary.by_status[st].amount += (r.final_price || 0);
  });

  // 按品类汇总
  records.forEach(r => {
    const cat = r.product_category || '未分类';
    if (!summary.by_category[cat]) summary.by_category[cat] = { count: 0, amount: 0, cost: 0 };
    summary.by_category[cat].count++;
    summary.by_category[cat].amount += (r.final_price || 0);
    summary.by_category[cat].cost += (r.base_cost || 0);
  });

  res.json(summary);
});

// ===== 考核周期设置 =====
router.get('/assessment-cycles', requirePerm('report:view'), (req, res) => {
  const table = getTable('assessment_cycles');
  res.json(table.all().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')));
});

router.post('/assessment-cycles', requirePerm('report:view'), (req, res) => {
  const { name, start_date, end_date, targets } = req.body;
  if (!name || !start_date || !end_date) {
    return res.status(400).json({ error: '周期名称、开始日期、结束日期为必填项' });
  }
  const table = getTable('assessment_cycles');
  const result = table.insert({
    name, start_date, end_date,
    targets: targets || { conversion_rate: 30, timely_rate: 80, lost_rate: 20 },
    status: 'active',
    created_at: now()
  });
  res.json({ message: '考核周期创建成功', data: table.findById(result.lastID) });
});

// ===== 培训计划管理 =====
router.get('/training-plans', requirePerm('report:view'), (req, res) => {
  const table = getTable('training_plans');
  res.json(table.all().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')));
});

router.post('/training-plans', requirePerm('report:view'), (req, res) => {
  const { title, target_persons, training_type, description, deadline } = req.body;
  if (!title || !training_type) {
    return res.status(400).json({ error: '培训标题和类型为必填项' });
  }
  const table = getTable('training_plans');
  const result = table.insert({
    title, target_persons: target_persons || [], training_type, description: description || '',
    deadline: deadline || '', status: 'planned',
    created_at: now()
  });
  res.json({ message: '培训计划创建成功', data: table.findById(result.lastID) });
});

router.put('/training-plans/:id', requirePerm('report:view'), (req, res) => {
  const { status } = req.body;
  const table = getTable('training_plans');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '培训计划不存在' });
  table.update(req.params.id, { status: status || existing.status });
  res.json({ message: '培训计划更新成功' });
});

module.exports = router;
