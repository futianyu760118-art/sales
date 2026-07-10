const DrawingPreview = {
  modal: null,
  currentDrawing: null,
  scale: 1,
  rotation: 0,
  translateX: 0,
  translateY: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  lastTranslateX: 0,
  lastTranslateY: 0,
  touchStartDist: 0,
  touchStartScale: 1,
  compareMode: false,
  compareDrawingId: null,

  init() {
    if (document.getElementById('drawingPreviewModal')) return;
    const modal = document.createElement('div');
    modal.id = 'drawingPreviewModal';
    modal.className = 'drawing-preview-modal';
    modal.innerHTML = `
      <div class="dp-overlay" onclick="DrawingPreview.close()"></div>
      <div class="dp-container">
        <div class="dp-header">
          <div class="dp-title" id="dpTitle">图纸预览</div>
          <div class="dp-header-actions">
            <button class="dp-btn" onclick="DrawingPreview.zoomIn()" title="放大">🔍+</button>
            <button class="dp-btn" onclick="DrawingPreview.zoomOut()" title="缩小">🔍-</button>
            <button class="dp-btn" onclick="DrawingPreview.resetView()" title="重置视图">⟲</button>
            <button class="dp-btn" onclick="DrawingPreview.rotateLeft()" title="左旋90°">↺</button>
            <button class="dp-btn" onclick="DrawingPreview.rotateRight()" title="右旋90°">↻</button>
            <button class="dp-btn" onclick="DrawingPreview.fitToWindow()" title="适应窗口">⊞</button>
            <button class="dp-btn dp-btn-compare" onclick="DrawingPreview.toggleCompare()" title="版本对比">⇔</button>
            <button class="dp-btn dp-btn-approve" onclick="DrawingPreview.showApproveDialog()" title="审批" data-perm="drawing:approve">✓</button>
            <button class="dp-btn dp-btn-log" onclick="DrawingPreview.showAuditLog()" title="操作日志">📋</button>
            <span class="dp-close" onclick="DrawingPreview.close()">✕</span>
          </div>
        </div>
        <div class="dp-body" id="dpBody">
          <div class="dp-viewer" id="dpViewer">
            <div class="dp-canvas-wrap" id="dpCanvasWrap">
              <canvas id="dpCanvas" style="display:none;"></canvas>
              <img id="dpImage" style="display:none;cursor:grab;" />
              <iframe id="dpPdfFrame" style="display:none;width:100%;height:100%;border:none;"></iframe>
              <div id="dpUnsupported" style="display:none;" class="dp-unsupported">
                <div class="dp-unsupported-icon">📐</div>
                <div>该格式暂不支持在线预览</div>
                <div style="font-size:12px;color:#999;margin-top:4px;">支持预览格式: PDF, JPG, PNG, GIF, BMP, SVG</div>
                <a id="dpDownloadLink" class="dp-btn" style="margin-top:12px;display:inline-block;text-decoration:none;" download>下载文件查看</a>
              </div>
            </div>
          </div>
          <div class="dp-sidebar" id="dpSidebar" style="display:none;">
            <div class="dp-sidebar-header">版本对比</div>
            <div class="dp-sidebar-content" id="dpCompareContent"></div>
          </div>
        </div>
        <div class="dp-footer">
          <div class="dp-info" id="dpInfo"></div>
          <div class="dp-version-nav" id="dpVersionNav"></div>
        </div>
      </div>
      <div class="dp-approve-dialog" id="dpApproveDialog" style="display:none;">
        <div class="dp-approve-content">
          <h4>图纸审批</h4>
          <div style="margin:12px 0;">
            <label style="display:block;font-size:13px;margin-bottom:4px;">审批人</label>
            <input type="text" id="dpApprover" class="dp-input" placeholder="输入审批人姓名">
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="dp-btn dp-btn-success" onclick="DrawingPreview.approve('approve')">通过</button>
            <button class="dp-btn dp-btn-danger" onclick="DrawingPreview.approve('reject')">驳回</button>
            <button class="dp-btn" onclick="DrawingPreview.hideApproveDialog()">取消</button>
          </div>
        </div>
      </div>
      <div class="dp-log-dialog" id="dpLogDialog" style="display:none;">
        <div class="dp-log-content">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <h4 style="margin:0;">操作日志</h4>
            <span class="dp-close" onclick="DrawingPreview.hideLogDialog()">✕</span>
          </div>
          <div id="dpLogList" style="max-height:400px;overflow:auto;"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    this.modal = modal;

    const viewer = document.getElementById('dpViewer');
    viewer.addEventListener('mousedown', (e) => this.onMouseDown(e));
    viewer.addEventListener('mousemove', (e) => this.onMouseMove(e));
    viewer.addEventListener('mouseup', (e) => this.onMouseUp(e));
    viewer.addEventListener('mouseleave', (e) => this.onMouseUp(e));
    viewer.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    viewer.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    viewer.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    viewer.addEventListener('touchend', (e) => this.onTouchEnd(e));

    window.addEventListener('keydown', (e) => {
      if (!this.currentDrawing) return;
      if (e.key === 'Escape') this.close();
      if (e.key === '+' || e.key === '=') this.zoomIn();
      if (e.key === '-') this.zoomOut();
      if (e.key === '0') this.resetView();
    });

    this.injectStyles();
  },

  injectStyles() {
    if (document.getElementById('drawingPreviewStyles')) return;
    const style = document.createElement('style');
    style.id = 'drawingPreviewStyles';
    style.textContent = `
      .drawing-preview-modal { display:none; position:fixed; top:0; left:0; width:100%; height:100%; z-index:10000; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
      .drawing-preview-modal.show { display:flex; }
      .dp-overlay { position:absolute; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); }
      .dp-container { position:relative; z-index:1; width:95%; height:95%; margin:auto; background:#1a1a2e; border-radius:12px; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 8px 32px rgba(0,0,0,0.4); }
      .dp-header { display:flex; justify-content:space-between; align-items:center; padding:8px 16px; background:#16213e; border-bottom:1px solid #2a3a5e; color:#e0e0e0; }
      .dp-title { font-size:14px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:40%; }
      .dp-header-actions { display:flex; align-items:center; gap:4px; }
      .dp-btn { padding:4px 10px; border:1px solid #3a4a6e; border-radius:6px; background:#2a3a5e; color:#e0e0e0; cursor:pointer; font-size:13px; transition:all 0.15s; white-space:nowrap; }
      .dp-btn:hover { background:#3a4a7e; border-color:#5a6a9e; }
      .dp-btn-compare { background:#1a3a5e; border-color:#2a5a8e; }
      .dp-btn-compare:hover { background:#2a5a8e; }
      .dp-btn-compare.active { background:#2a7ade; border-color:#4a9afe; }
      .dp-btn-approve { background:#1a4a2e; border-color:#2a7a4e; }
      .dp-btn-approve:hover { background:#2a7a4e; }
      .dp-btn-success { background:#1a5a2e; border-color:#2a8a4e; color:#4aff7a; }
      .dp-btn-success:hover { background:#2a8a4e; }
      .dp-btn-danger { background:#5a1a1a; border-color:#8a2a2a; color:#ff4a4a; }
      .dp-btn-danger:hover { background:#8a2a2a; }
      .dp-close { cursor:pointer; font-size:18px; color:#999; padding:0 4px; }
      .dp-close:hover { color:#fff; }
      .dp-body { flex:1; display:flex; overflow:hidden; position:relative; }
      .dp-viewer { flex:1; overflow:hidden; position:relative; background:#0f0f1a; display:flex; align-items:center; justify-content:center; user-select:none; -webkit-user-select:none; touch-action:none; }
      .dp-canvas-wrap { position:relative; display:flex; align-items:center; justify-content:center; width:100%; height:100%; }
      #dpImage { max-width:none; max-height:none; transition:transform 0.1s ease-out; pointer-events:none; }
      #dpPdfFrame { background:white; }
      .dp-unsupported { text-align:center; color:#aaa; padding:40px; }
      .dp-unsupported-icon { font-size:48px; margin-bottom:12px; }
      .dp-sidebar { width:300px; background:#16213e; border-left:1px solid #2a3a5e; display:flex; flex-direction:column; }
      .dp-sidebar-header { padding:10px 14px; font-size:13px; font-weight:600; color:#e0e0e0; border-bottom:1px solid #2a3a5e; }
      .dp-sidebar-content { flex:1; overflow:auto; padding:10px; }
      .dp-compare-item { display:flex; gap:8px; margin-bottom:8px; background:#1a2a4e; border-radius:8px; overflow:hidden; }
      .dp-compare-item .dp-compare-panel { flex:1; padding:8px; text-align:center; }
      .dp-compare-item .dp-compare-panel img { max-width:100%; max-height:200px; border-radius:4px; }
      .dp-compare-item .dp-compare-label { font-size:11px; color:#8a9abe; margin-bottom:4px; }
      .dp-footer { display:flex; justify-content:space-between; align-items:center; padding:6px 16px; background:#16213e; border-top:1px solid #2a3a5e; color:#8a9abe; font-size:12px; }
      .dp-info { display:flex; gap:12px; }
      .dp-version-nav { display:flex; gap:4px; }
      .dp-version-btn { padding:2px 8px; border:1px solid #2a3a5e; border-radius:4px; background:transparent; color:#8a9abe; cursor:pointer; font-size:11px; }
      .dp-version-btn:hover { background:#2a3a5e; }
      .dp-version-btn.active { background:#2a7ade; color:white; border-color:#4a9afe; }
      .dp-approve-dialog { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); z-index:10; }
      .dp-approve-content { background:#1a2a4e; border:1px solid #3a5a8e; border-radius:12px; padding:20px; min-width:300px; color:#e0e0e0; }
      .dp-approve-content h4 { margin:0 0 12px; color:#e0e0e0; }
      .dp-input { width:100%; padding:8px 12px; border:1px solid #3a5a8e; border-radius:6px; background:#0f1a2e; color:#e0e0e0; font-size:13px; box-sizing:border-box; }
      .dp-input:focus { outline:none; border-color:#4a9afe; }
      .dp-log-dialog { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); z-index:10; }
      .dp-log-content { background:#1a2a4e; border:1px solid #3a5a8e; border-radius:12px; padding:20px; min-width:400px; max-width:600px; color:#e0e0e0; }
      .dp-log-item { padding:6px 0; border-bottom:1px solid #2a3a5e; font-size:12px; display:flex; gap:8px; }
      .dp-log-action { font-weight:600; min-width:50px; }
      .dp-log-action.preview { color:#4a9afe; }
      .dp-log-action.upload { color:#4aff7a; }
      .dp-log-action.download { color:#ffaa4a; }
      .dp-log-action.approve { color:#4aff7a; }
      .dp-log-action.reject { color:#ff4a4a; }
      .dp-log-action.delete { color:#ff4a4a; }
      .dp-log-action.update { color:#ffaa4a; }
      .dp-log-time { color:#6a7a9e; white-space:nowrap; }
      .dp-log-detail { color:#8a9abe; flex:1; }
      @media (max-width:768px) {
        .dp-container { width:100%; height:100%; border-radius:0; }
        .dp-header-actions { flex-wrap:wrap; gap:2px; }
        .dp-btn { padding:3px 6px; font-size:11px; }
        .dp-sidebar { width:100%; position:absolute; top:0; right:0; bottom:0; z-index:5; }
        .dp-title { max-width:25%; font-size:12px; }
      }
    `;
    document.head.appendChild(style);
  },

  async open(drawingId, operator) {
    this.init();
    this.resetView();
    this.currentDrawing = null;
    this.compareMode = false;

    try {
      const res = await fetch(`/api/materials-ext/drawings/${drawingId}/versions?operator=${operator || 'system'}`);
      const data = await res.json();
      const versions = data.data || [];
      const current = versions.find(v => v.id === Number(drawingId));
      if (!current) { alert('图纸不存在'); return; }

      this.currentDrawing = current;
      this.allVersions = versions;
      this.operator = operator || 'system';

      document.getElementById('dpTitle').textContent = `${current.file_name} - V${current.version}`;
      this.modal.classList.add('show');
      document.body.style.overflow = 'hidden';

      this.renderVersionNav();
      this.renderInfo();
      this.loadPreview(current);

      fetch(`/api/materials-ext/drawings/${drawingId}/preview?operator=${this.operator}`).catch(() => {});
    } catch (e) {
      alert('加载图纸信息失败');
    }
  },

  loadPreview(drawing) {
    const img = document.getElementById('dpImage');
    const pdfFrame = document.getElementById('dpPdfFrame');
    const unsupported = document.getElementById('dpUnsupported');
    const downloadLink = document.getElementById('dpDownloadLink');

    img.style.display = 'none';
    pdfFrame.style.display = 'none';
    unsupported.style.display = 'none';

    const ext = drawing.file_type;
    const imageTypes = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
    const pdfType = '.pdf';
    const cadTypes = ['.dwg', '.dxf', '.step', '.stp', '.igs'];

    if (imageTypes.includes(ext)) {
      img.style.display = 'block';
      img.src = `/api/materials-ext/drawings/${drawing.id}/preview?operator=${this.operator}&t=${Date.now()}`;
      img.onload = () => {
        this.naturalWidth = img.naturalWidth;
        this.naturalHeight = img.naturalHeight;
        this.fitToWindow();
      };
      img.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale}) rotate(${this.rotation}deg)`;
    } else if (ext === pdfType) {
      pdfFrame.style.display = 'block';
      pdfFrame.src = `/api/materials-ext/drawings/${drawing.id}/preview?operator=${this.operator}&t=${Date.now()}`;
    } else {
      unsupported.style.display = 'block';
      downloadLink.href = `/api/materials-ext/drawings/${drawing.id}/download?operator=${this.operator}`;
      downloadLink.textContent = `下载 ${drawing.file_name}`;
    }
  },

  close() {
    if (this.modal) {
      this.modal.classList.remove('show');
      document.body.style.overflow = '';
    }
    this.currentDrawing = null;
    this.compareMode = false;
    const sidebar = document.getElementById('dpSidebar');
    if (sidebar) sidebar.style.display = 'none';
  },

  zoomIn() { this.setScale(this.scale * 1.2); },
  zoomOut() { this.setScale(this.scale / 1.2); },

  setScale(newScale) {
    newScale = Math.max(0.1, Math.min(20, newScale));
    this.scale = newScale;
    this.applyTransform();
    this.updateInfoZoom();
  },

  resetView() {
    this.scale = 1;
    this.rotation = 0;
    this.translateX = 0;
    this.translateY = 0;
    this.applyTransform();
  },

  fitToWindow() {
    const img = document.getElementById('dpImage');
    if (!img || img.style.display === 'none') return;
    const viewer = document.getElementById('dpViewer');
    if (!viewer || !this.naturalWidth) return;
    const vw = viewer.clientWidth - 40;
    const vh = viewer.clientHeight - 40;
    const scaleX = vw / this.naturalWidth;
    const scaleY = vh / this.naturalHeight;
    this.scale = Math.min(scaleX, scaleY, 1);
    this.translateX = 0;
    this.translateY = 0;
    this.rotation = 0;
    this.applyTransform();
  },

  rotateLeft() {
    this.rotation -= 90;
    this.applyTransform();
  },

  rotateRight() {
    this.rotation += 90;
    this.applyTransform();
  },

  applyTransform() {
    const img = document.getElementById('dpImage');
    if (img && img.style.display !== 'none') {
      img.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale}) rotate(${this.rotation}deg)`;
      img.style.transformOrigin = 'center center';
    }
  },

  onMouseDown(e) {
    if (e.target.closest('.dp-sidebar') || e.target.closest('iframe')) return;
    this.isDragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.lastTranslateX = this.translateX;
    this.lastTranslateY = this.translateY;
    const img = document.getElementById('dpImage');
    if (img) img.style.cursor = 'grabbing';
  },

  onMouseMove(e) {
    if (!this.isDragging) return;
    this.translateX = this.lastTranslateX + (e.clientX - this.dragStartX);
    this.translateY = this.lastTranslateY + (e.clientY - this.dragStartY);
    this.applyTransform();
  },

  onMouseUp(e) {
    this.isDragging = false;
    const img = document.getElementById('dpImage');
    if (img) img.style.cursor = 'grab';
  },

  onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = document.getElementById('dpViewer').getBoundingClientRect();
    const mouseX = e.clientX - rect.left - rect.width / 2;
    const mouseY = e.clientY - rect.top - rect.height / 2;
    const newScale = Math.max(0.1, Math.min(20, this.scale * delta));
    const ratio = newScale / this.scale;
    this.translateX = mouseX - ratio * (mouseX - this.translateX);
    this.translateY = mouseY - ratio * (mouseY - this.translateY);
    this.scale = newScale;
    this.applyTransform();
    this.updateInfoZoom();
  },

  onTouchStart(e) {
    if (e.touches.length === 1) {
      this.isDragging = true;
      this.dragStartX = e.touches[0].clientX;
      this.dragStartY = e.touches[0].clientY;
      this.lastTranslateX = this.translateX;
      this.lastTranslateY = this.translateY;
    } else if (e.touches.length === 2) {
      e.preventDefault();
      this.isDragging = false;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      this.touchStartDist = Math.sqrt(dx * dx + dy * dy);
      this.touchStartScale = this.scale;
    }
  },

  onTouchMove(e) {
    if (e.touches.length === 1 && this.isDragging) {
      e.preventDefault();
      this.translateX = this.lastTranslateX + (e.touches[0].clientX - this.dragStartX);
      this.translateY = this.lastTranslateY + (e.touches[0].clientY - this.dragStartY);
      this.applyTransform();
    } else if (e.touches.length === 2) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const newScale = Math.max(0.1, Math.min(20, this.touchStartScale * (dist / this.touchStartDist)));
      this.scale = newScale;
      this.applyTransform();
    }
  },

  onTouchEnd(e) {
    this.isDragging = false;
  },

  renderVersionNav() {
    const nav = document.getElementById('dpVersionNav');
    if (!this.allVersions || this.allVersions.length <= 1) { nav.innerHTML = ''; return; }
    nav.innerHTML = this.allVersions.map(v =>
      `<button class="dp-version-btn ${v.id === this.currentDrawing.id ? 'active' : ''}" onclick="DrawingPreview.switchVersion(${v.id})">V${v.version}</button>`
    ).join('');
  },

  async switchVersion(id) {
    const drawing = this.allVersions.find(v => v.id === id);
    if (!drawing) return;
    this.currentDrawing = drawing;
    this.resetView();
    document.getElementById('dpTitle').textContent = `${drawing.file_name} - V${drawing.version}`;
    this.renderVersionNav();
    this.renderInfo();
    this.loadPreview(drawing);
  },

  renderInfo() {
    const info = document.getElementById('dpInfo');
    if (!this.currentDrawing) return;
    const d = this.currentDrawing;
    const approvalLabels = { pending: '待审批', approved: '已通过', rejected: '已驳回' };
    const approvalColors = { pending: '#ffaa4a', approved: '#4aff7a', rejected: '#ff4a4a' };
    info.innerHTML = `
      <span>版本: V${d.version}</span>
      <span>大小: ${(d.file_size / 1024).toFixed(1)}KB</span>
      <span>格式: ${(d.file_type || '').toUpperCase()}</span>
      <span style="color:${approvalColors[d.approval_status] || '#8a9abe'}">审批: ${approvalLabels[d.approval_status] || d.approval_status || '待审批'}</span>
      ${d.drawing_no ? `<span>图号: ${d.drawing_no}</span>` : ''}
    `;
  },

  updateInfoZoom() {
    const info = document.getElementById('dpInfo');
    if (!info) return;
    const zoomSpan = info.querySelector('.dp-zoom');
    if (zoomSpan) zoomSpan.textContent = `${Math.round(this.scale * 100)}%`;
    else info.innerHTML += `<span class="dp-zoom">${Math.round(this.scale * 100)}%</span>`;
  },

  async toggleCompare() {
    const btn = document.querySelector('.dp-btn-compare');
    const sidebar = document.getElementById('dpSidebar');
    this.compareMode = !this.compareMode;

    if (this.compareMode) {
      btn.classList.add('active');
      sidebar.style.display = 'flex';
      await this.loadCompareContent();
    } else {
      btn.classList.remove('active');
      sidebar.style.display = 'none';
    }
  },

  async loadCompareContent() {
    const container = document.getElementById('dpCompareContent');
    if (!this.allVersions || this.allVersions.length < 2) {
      container.innerHTML = '<div style="color:#8a9abe;font-size:12px;text-align:center;padding:20px;">仅有一个版本，无法对比</div>';
      return;
    }

    const versions = this.allVersions.slice().sort((a, b) => b.version - a.version);
    let html = '';
    for (let i = 0; i < versions.length - 1; i++) {
      const v1 = versions[i];
      const v2 = versions[i + 1];
      const canPreview1 = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.pdf'].includes(v1.file_type);
      const canPreview2 = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.pdf'].includes(v2.file_type);

      html += `<div class="dp-compare-item">
        <div class="dp-compare-panel">
          <div class="dp-compare-label">V${v1.version} (当前)</div>
          ${canPreview1 ? `<img src="/api/materials-ext/drawings/${v1.id}/preview?operator=${this.operator || 'system'}&t=${Date.now()}" style="max-height:150px;" onclick="DrawingPreview.switchVersion(${v1.id})">` : `<div style="padding:20px;color:#6a7a9e;">${v1.file_type} 格式</div>`}
          <div style="font-size:10px;color:#6a7a9e;margin-top:4px;">${(v1.file_size / 1024).toFixed(1)}KB | ${v1.created_at || ''}</div>
        </div>
        <div class="dp-compare-panel">
          <div class="dp-compare-label">V${v2.version}</div>
          ${canPreview2 ? `<img src="/api/materials-ext/drawings/${v2.id}/preview?operator=${this.operator || 'system'}&t=${Date.now()}" style="max-height:150px;" onclick="DrawingPreview.switchVersion(${v2.id})">` : `<div style="padding:20px;color:#6a7a9e;">${v2.file_type} 格式</div>`}
          <div style="font-size:10px;color:#6a7a9e;margin-top:4px;">${(v2.file_size / 1024).toFixed(1)}KB | ${v2.created_at || ''}</div>
        </div>
      </div>`;
    }
    container.innerHTML = html;
  },

  showApproveDialog() {
    document.getElementById('dpApproveDialog').style.display = 'block';
    document.getElementById('dpApprover').value = '';
    document.getElementById('dpApprover').focus();
  },

  hideApproveDialog() {
    document.getElementById('dpApproveDialog').style.display = 'none';
  },

  async approve(action) {
    const approver = document.getElementById('dpApprover').value.trim();
    if (!approver) { alert('请输入审批人姓名'); return; }
    if (!this.currentDrawing) return;

    try {
      const res = await fetch(`/api/materials-ext/drawings/${this.currentDrawing.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved_by: approver, action })
      });
      const result = await res.json();
      alert(result.message);
      this.hideApproveDialog();
      this.renderInfo();
    } catch (e) {
      alert('审批操作失败');
    }
  },

  async showAuditLog() {
    if (!this.currentDrawing) return;
    try {
      const res = await fetch(`/api/materials-ext/drawings/${this.currentDrawing.id}/audit-logs`);
      const data = await res.json();
      const logs = data.data || [];
      const container = document.getElementById('dpLogList');

      if (logs.length === 0) {
        container.innerHTML = '<div style="text-align:center;color:#6a7a9e;padding:20px;">暂无操作日志</div>';
      } else {
        container.innerHTML = logs.map(l => `
          <div class="dp-log-item">
            <span class="dp-log-action ${l.action}">${l.action}</span>
            <span class="dp-log-detail">${l.detail || l.operator}</span>
            <span class="dp-log-time">${l.created_at || ''}</span>
          </div>
        `).join('');
      }
      document.getElementById('dpLogDialog').style.display = 'block';
    } catch (e) {
      alert('加载日志失败');
    }
  },

  hideLogDialog() {
    document.getElementById('dpLogDialog').style.display = 'none';
  }
};
