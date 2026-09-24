# 数据供给 API 使用说明

## 1. 接入流程

1. 在 **数据范围配置** 中启用需要的数据类型
2. 在 **API Key 管理** 中创建一个 API Key，勾选允许访问的数据类型与对外接口
3. 妥善保存生成的 AppKey + AppSecret（仅显示一次），将其配置到外部系统中
4. 外部系统调用 API 时，使用 HMAC-SHA256 签名认证

## 2. 两类接口

| 接口类别 | 路径前缀 | 权限字段 | 说明 |
|----------|----------|----------|------|
| 通用数据供给 | `http://192.168.0.178:3000/api/v1/basicdata/data-supply/data/{data_type}` | allowed_data_types | 按数据类型查询，字段由配置决定 |
| 对外业务接口 | `http://192.168.0.178:3000/api/v1/external/...` | allowed_endpoints | 按业务场景封装，字段固定精简 |

> 两类接口共用同一套 API Key / 签名算法，但**权限分别控制**：allowed_data_types 控制 /data/* ，allowed_endpoints 控制 /external/*。

## 3. 认证方式

采用 HMAC-SHA256 签名认证（AppSecret 不在网络传输）：

每次请求携带以下三个请求头：

| 请求头 | 说明 | 示例 |
|--------|------|------|
| `X-App-Key` | 应用标识（AppKey） | `ak_a1b2c3d4e5f6g7h8` |
| `X-Timestamp` | 当前 Unix 时间戳（秒） | `1719000000` |
| `X-Signature` | HMAC-SHA256 签名 | `a3f2b1c4d5e6...` |

**签名算法：**

```
通用接口：待签名串 = timestamp + app_key + data_type + query_string
对外接口：待签名串 = timestamp + app_key + endpoint_code + query_string

例：1719000000ak_a1b2c3d4e5f6g7h8orders.listpage=1&page_size=20

用 AppSecret 对待签名串做 HMAC-SHA256，结果转十六进制小写放入 X-Signature
```

> 注意：对外接口签名中用的是 **endpoint_code（如 orders.list）**，不是 URL 路径。
> query_string 必须与实际请求 URL 中 `?` 后的内容完全一致（含顺序），无参数时为空串。

**防重放：** 时间戳与服务器时间差超过 5 分钟，请求将被拒绝。

## 4. 对外业务接口清单

| endpoint_code | 名称 | 路径 | 说明 |
|---------------|------|------|------|
| orders.list | 订单列表 | `GET /external/orders/list` | 销售订单行列表查询，支持关键字、状态、客户、风险等级、合同交期范围、增量同步 |
| boms.list | BOM列表 | `GET /external/boms/list` | BOM列表查询，支持按物料代码、BOM编号、版本号、类型、使用状态、增量同步 |
| bom_details.list | BOM明细列表 | `GET /external/bom-details/list` | BOM明细列表查询，支持按BOM ID、物料ID、增量同步 |
| customers.list | 客户列表 | `GET /external/customers/list` | 客户主数据列表查询，支持关键字、客户等级、行业、状态、增量同步 |
| suppliers.list | 供应商列表 | `GET /external/suppliers/list` | 供应商主数据列表查询，支持关键字、类型、状态、增量同步（联系电话脱敏） |
| materials.list | 物料列表 | `GET /external/materials/list` | 物料主数据列表查询，支持关键字、物料分类、采购/生产属性、状态、增量同步 |
| products.list | 产品列表 | `GET /external/products/list` | 产品主数据列表查询，支持关键字、产品线、增量同步 |
| purchase_orders.list | 采购订单列表 | `GET /external/purchase-orders/list` | 采购订单/到料计划列表查询，支持关键字、PO 状态、供应商、ETA 范围、增量同步 |
| schedule_plans.list | 生产排产计划列表 | `GET /external/schedule-plans/list` | 生产排产计划列表查询，支持关键字、部门、状态、订单号、排产日期范围、增量同步（默认只返回生效版本） |
| organizations.list | 组织列表 | `GET /external/organizations/list` | 组织架构列表查询，支持关键字、组织类型、状态筛选 |
| positions.list | 岗位列表 | `GET /external/positions/list` | 岗位列表查询，支持关键字、状态筛选 |
| employees.list | 员工列表 | `GET /external/employees/list` | 员工列表查询，支持关键字、组织、岗位、状态筛选（手机号脱敏） |
| organizations.employees | 组织员工 | `GET /external/organizations/{oa_org_id}/employees` | 查询指定组织（含子组织）下的员工列表 |
| inventory.list | 库存列表 | `GET /external/inventory/list` | 即时库存明细查询（物料×仓库×库位），支持关键字、物料/仓库/批次筛选、增量同步 |
| warehouses.list | 仓库列表 | `GET /external/warehouses/list` | 仓库主数据列表查询，支持关键字、仓库类型、仓库属性、启用状态、增量同步 |
| locations.list | 库位列表 | `GET /external/locations/list` | 库位主数据列表查询，支持关键字、父库位、明细标识、增量同步 |

每个接口均支持 page / page_size 分页、keyword 关键字、updated_after 增量同步，具体筛选条件见各接口文档。

## 5. 通用数据供给接口

### 5.1 查询数据列表

`GET http://192.168.0.178:3000/api/v1/basicdata/data-supply/data/{data_type}`

| 参数 | 位置 | 必填 | 说明 |
|------|------|------|------|
| `data_type` | Path | 是 | 数据类型标识 |
| `page` | Query | 否 | 页码，默认 1 |
| `page_size` | Query | 否 | 每页条数，默认 20，最大 200 |
| `keyword` | Query | 否 | 关键字搜索 |
| `updated_after` | Query | 否 | 增量同步：ISO 8601 时间，只返回此时间后更新的数据 |

### 5.2 查询单条数据

`GET http://192.168.0.178:3000/api/v1/basicdata/data-supply/data/{data_type}/{record_id}`

### 5.3 响应格式

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "items": [...],
    "total": 100,
    "page": 1,
    "page_size": 20
  }
}
```

## 6. 可用数据类型

| data_type | 中文名 | 暴露字段 |
|-----------|--------|----------|
| customers | 客户 | （由配置决定） |
| suppliers | 供应商 | （由配置决定） |
| materials | 物料 | （由配置决定） |
| products | 产品 | （由配置决定） |
| boms | BOM | （由配置决定） |
| bom_details | BOM明细 | （由配置决定） |
| warehouses | 仓库 | （由配置决定） |
| processes | 工序 | （由配置决定） |
| organizations | 组织 | （由配置决定） |
| positions | 岗位 | （由配置决定） |
| employees | 人员 | （由配置决定） |
| orders | 销售订单 | （由配置决定） |
| purchase_orders | 采购订单 | （由配置决定） |
| schedule_plans | 生产排产计划 | （由配置决定） |
| work_orders | 工单 | （由配置决定） |
| process_exceptions | 工序异常 | （由配置决定） |
| process_progress | 工序进度 | （由配置决定） |

## 7. 调用示例

### Python（对外接口签名认证）

```python
import hmac, hashlib, time, requests

APP_KEY = "ak_xxxxxxxx"
APP_SECRET = "your_app_secret"
ENDPOINT_CODE = "orders.list"   # 注意：用接口代码，不是 URL 路径

query_string = "page=1&page_size=20"
timestamp = str(int(time.time()))
string_to_sign = f"{timestamp}{APP_KEY}{ENDPOINT_CODE}{query_string}"
signature = hmac.new(APP_SECRET.encode(), string_to_sign.encode(), hashlib.sha256).hexdigest()

resp = requests.get(
    "http://192.168.0.178:3000/api/v1/external/orders/list",
    params={"page": 1, "page_size": 20},
    headers={
        "X-App-Key": APP_KEY,
        "X-Timestamp": timestamp,
        "X-Signature": signature,
    },
)
print(resp.json())
```

### Python（通用数据供给接口）

```python
import hmac, hashlib, time, requests

BASE_URL = "http://192.168.0.178:3000/api/v1/basicdata/data-supply"
APP_KEY = "ak_xxxxxxxx"
APP_SECRET = "your_app_secret"

data_type = "materials"
query_string = "page=1&page_size=20"
timestamp = str(int(time.time()))
string_to_sign = f"{timestamp}{APP_KEY}{data_type}{query_string}"
signature = hmac.new(APP_SECRET.encode(), string_to_sign.encode(), hashlib.sha256).hexdigest()

resp = requests.get(
    f"{BASE_URL}/data/{data_type}",
    params={"page": 1, "page_size": 20},
    headers={"X-App-Key": APP_KEY, "X-Timestamp": timestamp, "X-Signature": signature},
)
print(resp.json())
```

### cURL

```bash
TIMESTAMP=$(date +%s)
APP_KEY="ak_xxxxxxxx"
APP_SECRET="your_app_secret"
ENDPOINT="orders.list"
QS="page=1&page_size=20"
SIG=$(echo -n "${TIMESTAMP}${APP_KEY}${ENDPOINT}${QS}" \
  | openssl dgst -sha256 -hmac "$APP_SECRET" | awk '{print $NF}')

curl "http://192.168.0.178:3000/api/v1/external/orders/list?page=1&page_size=20" \
  -H "X-App-Key: $APP_KEY" -H "X-Timestamp: $TIMESTAMP" -H "X-Signature: $SIG"
```

## 8. 安全机制

| 机制 | 说明 |
|------|------|
| HMAC-SHA256 签名 | AppSecret 不在网络传输，仅用于本地签名计算 |
| 时间戳校验 | 请求时间与服务器时间差超过 5 分钟则拒绝，防重放攻击 |
| IP 白名单 | 可为每个 API Key 配置允许的来源 IP |
| 字段级脱敏 | 手机号、邮箱等敏感字段自动脱敏（如 138****1234） |
| 接口级权限 | allowed_data_types / allowed_endpoints 分别控制两类接口的访问范围 |

## 9. 错误码说明

| HTTP 状态码 | 含义 | 排查建议 |
|-------------|------|----------|
| 401 | 缺少认证信息 | 检查是否携带了 X-App-Key/X-Timestamp/X-Signature |
| 403 | 认证失败或无权限 | 签名不匹配、Key 已过期、IP 不在白名单、或未授权该接口/数据类型 |
| 404 | 数据类型未启用或记录不存在 | 在数据范围配置中启用该数据类型 |
| 500 | 服务器内部错误 | 联系管理员排查 |
