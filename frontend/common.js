/**
 * common.js - 全局通用工具
 * 提供 esc() HTML 转义、XSS 防护等
 */
(function(window){
  // HTML 转义（防 XSS）
  function esc(s){
    if(s==null)return'';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  // 截断
  function trunc(s,n){
    s=String(s==null?'':s);
    return s.length>n?s.slice(0,n)+'…':s;
  }
  // 安全 URL（仅 http/https）
  function safeUrl(url){
    if(!url)return'';
    var s=String(url).trim();
    if(/^https?:\/\//i.test(s))return s;
    return'';
  }
  // CSV 公式注入防护
  function csvSafe(s){
    if(s==null)return'';
    s=String(s);
    if(s.length>0&&/^[=+\-@\t\r]/.test(s))return"'"+s;
    return s;
  }
  window.esc=esc;window.trunc=trunc;window.safeUrl=safeUrl;window.csvSafe=csvSafe;
  // 兼容已有 escHtml 别名
  window.escHtml=esc;
})(window);
