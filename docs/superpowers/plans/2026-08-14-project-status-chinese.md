# 研发项目状态中文显示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让研发项目数据库的新增/编辑状态下拉框和项目表格统一显示中文，同时保持 API 使用现有状态编码。

**Architecture:** 在两个实际存在的项目页面副本中统一维护项目状态编码到中文标签的配置。表单 `<option>` 的 `value` 使用编码、文本使用中文，列表和内联编辑复用同一映射；后端接口和数据库不变。

**Tech Stack:** 原生 HTML/JavaScript、Node.js `assert` 回归脚本、PowerShell。

## Global Constraints

- 状态编码必须保持 `init`、`executing`、`completed`、`paused`、`cancelled`。
- 中文标签必须分别为“预项目”“进行中”“已完成”“暂停”“取消”。
- 必须同步修改 `frontend/project.html` 与 `frontend/frontend/project.html`。
- 不修改后端接口、数据库字段、历史数据或其他状态逻辑。

---

### Task 1: Add a failing status-display regression test

**Files:**
- Create: `scripts/project-status-regression.test.js`

**Interfaces:**
- Consumes: the two page files as UTF-8 text.
- Produces: a standalone Node.js regression test that fails while the nested page still renders raw status codes.

- [ ] **Step 1: Write the failing test**

  Add a Node script that reads both page files and asserts each page contains the five required `statusMap` pairs, and that its generic select renderer uses `statusMap[o] || o` for option text. Also assert the status form declaration keeps the five encoded values in order.

  The test must use `require('node:assert/strict')`, `fs.readFileSync`, and `path.join(__dirname, '..', ...)`, and print `project status regression checks passed` only after all assertions pass.

- [ ] **Step 2: Run the test and verify it fails**

  Run:

  ```powershell
  node scripts/project-status-regression.test.js
  ```

  Expected: FAIL against `frontend/frontend/project.html` because its generic select renderer currently emits `${o}` instead of `${statusMap[o]||o}`.

### Task 2: Unify status labels in both project page copies

**Files:**
- Modify: `frontend/project.html:359, 762, 2911-2913`
- Modify: `frontend/frontend/project.html:333, 720, 2475-2477`

**Interfaces:**
- Consumes: `statusMap` and existing encoded status form declarations.
- Produces: Chinese labels in edit/add forms and inline status editing while preserving encoded values in submitted requests.

- [ ] **Step 1: Implement the minimal rendering fix**

  In the nested copy, change the generic select option template from raw text:

  ```js
  ${opts.map(o=>`<option value="${o}" ${val===o?'selected':''}>${o}</option>`).join('')}
  ```

  to the shared mapping form:

  ```js
  ${opts.map(o=>`<option value="${o}" ${val===o?'selected':''}>${statusMap[o]||o}</option>`).join('')}
  ```

  Ensure the top-level copy retains the same mapping and that both copies’ inline status editors use `statusMap[o] || o || '--'` for display. Do not change any `value` attributes or status API payloads.

- [ ] **Step 2: Run the focused regression test**

  Run:

  ```powershell
  node scripts/project-status-regression.test.js
  ```

  Expected: PASS and output `project status regression checks passed`.

- [ ] **Step 3: Run JavaScript syntax checks**

  Run:

  ```powershell
  node --check scripts/project-status-regression.test.js
  node --check backend/routes/project.js
  ```

  Expected: both commands exit with code 0. The HTML files are checked by the focused regression assertions because their JavaScript is embedded in HTML.

- [ ] **Step 4: Review the final diff and worktree scope**

  Run:

  ```powershell
  git diff --check
  git diff -- frontend/project.html frontend/frontend/project.html scripts/project-status-regression.test.js
  git status --short
  ```

  Expected: the functional diff is limited to the two project page copies and the new regression test; existing unrelated user changes remain untouched.

- [ ] **Step 5: Commit the implementation**

  ```powershell
  git add -- frontend/project.html frontend/frontend/project.html scripts/project-status-regression.test.js
  git commit -m "fix: show project statuses in Chinese"
  ```
