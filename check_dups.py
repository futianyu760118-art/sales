import json, os
from collections import Counter

base = r"C:\Users\colorful\Downloads\sales-service-system\database"
opath = os.path.join(base, "orders.json")

with open(opath, 'r', encoding='utf-8') as f:
    orders = json.load(f).get('records', [])

print(f"orders 总记录: {len(orders)}")

# 1) order_no + line_no 重复
key_count = Counter()
for o in orders:
    key = f"{o.get('order_no','')}|{o.get('line_no','')}"
    key_count[key] += 1
dup_keys = [k for k,v in key_count.items() if v > 1]
print(f"唯一键(order_no+line_no): {len(key_count)}")
print(f"重复键数: {len(dup_keys)}")

if dup_keys:
    print("\n--- 重复样例 ---")
    seen = set()
    for o in orders:
        key = f"{o.get('order_no','')}|{o.get('line_no','')}"
        if key in dup_keys and key not in seen:
            seen.add(key)
            dups = [x for x in orders if f"{x.get('order_no','')}|{x.get('line_no','')}" == key]
            print(f"  {key}: {len(dups)}条")
            for d in dups[:2]:
                print(f"    id={d.get('id')} qty={d.get('quantity')} amt={d.get('order_amount')} cust={d.get('customer_name')} prod={d.get('product_code')}")
            if len(seen) >= 3:
                break

# 2) order_no 重复（不同 line_no 不算，但检查完全重复的行）
total_dup_records = sum(v for v in key_count.values() if v > 1)
print(f"\n重复记录总数: {total_dup_records}")

# 3) order_analysis 多卡
apath = os.path.join(base, "order_analysis.json")
if os.path.exists(apath):
    with open(apath, 'r', encoding='utf-8') as f:
        analyses = json.load(f).get('records', [])
    oid_counter = Counter(a.get('order_id') for a in analyses)
    dups = [k for k,v in oid_counter.items() if v > 1]
    print(f"\norder_analysis 总卡: {len(analyses)}")
    print(f"一订单多分析卡: {len(dups)}单")
    if dups:
        for oid in dups[:3]:
            cards = [a for a in analyses if a.get('order_id') == oid]
            print(f"  order_id={oid}: {len(cards)}卡 status={[c.get('review_status') for c in cards]}")
    print(f"其中待删除的旧/空卡: {len([a for a in analyses if a.get('plan_total_cost') == None and a.get('actual_total_cost') == None])}")

# 4) order_cost_snapshots 多快照
spath = os.path.join(base, "order_cost_snapshots.json")
if os.path.exists(spath):
    fsize = os.path.getsize(spath)
    print(f"\norder_cost_snapshots 文件大小: {round(fsize/1024/1024,1)}MB")
    with open(spath, 'r', encoding='utf-8') as f:
        snaps = json.load(f).get('records', [])
    print(f"快照总数: {len(snaps)}")
    snap_count = Counter((s.get('order_analysis_id'), s.get('snapshot_type')) for s in snaps)
    multi_snap = [k for k,v in snap_count.items() if v > 1]
    print(f"同分析卡同类型多快照: {len(multi_snap)}组")
    if multi_snap:
        for k in multi_snap[:3]:
            print(f"  analysis_id={k[0]} type={k[1]} count={snap_count[k]}")

# 5) order_products 多产品
ppath = os.path.join(base, "order_products.json")
if os.path.exists(ppath):
    with open(ppath, 'r', encoding='utf-8') as f:
        prods = json.load(f).get('records', [])
    op_counter = Counter(f"{p.get('order_id')}|{p.get('product_code')}" for p in prods)
    op_dups = [k for k,v in op_counter.items() if v > 1]
    print(f"\norder_products 总记录: {len(prods)}")
    print(f"同订单+同产品重复: {len(op_dups)}组")
    total_op_dup = sum(v for v in op_counter.values() if v > 1)
    print(f"重复记录数: {total_op_dup}")
