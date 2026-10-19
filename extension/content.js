/**
 * content.js —— 内容脚本
 * 职责：
 *   1. 判断当前页面是否为商品详情页
 *   2. 在右下角注入「获取图片」悬浮按钮
 *   3. 扫描页面所有商品相关图片（img / srcset / data-* / 背景图）
 *   4. 过滤图标、logo、占位图、小图，补全绝对 URL 并去重
 *   5. 通过 chrome.runtime.sendMessage 把图片列表传给后台
 *
 * 注意：所有注入 DOM 的类名均以 __ee_ext_ 前缀，避免与页面原有样式冲突。
 */

(function () {
  'use strict';

  // 若页面已由本脚本处理过（或按钮已存在），避免重复注入
  if (window.__EE_EXT_INITIALIZED__ || document.querySelector('.__ee_ext_btn')) return;
  window.__EE_EXT_INITIALIZED__ = true;

  // ---------------- 常量配置 ----------------
  const MIN_SIZE = 100; // 过滤掉宽或高小于该值的图片（单位 px）
  const MAX_IMAGES = 500; // 单次最多提取数量，防止海量图片导致卡顿

  // 命中即视为「非商品图」的关键词（匹配 URL 与 alt 文本，忽略大小写）
  const FILTER_KEYWORDS = [
    'icon', 'logo', 'placeholder', 'avatar', 'empty', 'loading',
    'sprite', 'blank', 'default', 'ad', 'banner-bg', 'bg-icon',
    'favicon', 'thumb-s', 'pixel'
  ];

  // ---------------- 详情页判断 ----------------
  /**
   * 判断当前 URL 是否属于商品详情页。
   * 不同平台详情页路径形态不同，这里做兼容处理。
   */
  function isProductDetailPage() {
    const href = location.href;
    const path = location.pathname || '';

    // 淘宝 / 天猫：/item.htm?id=xxx（含 detail.tmall.com/item.htm）
    if (/taobao\.com|tmall\.com/i.test(location.hostname)) {
      return path.indexOf('/item.htm') !== -1;
    }
    // 京东：item.jd.com/<sku>.html，或 /item/ 路径
    if (/jd\.com/i.test(location.hostname)) {
      return /\/item(\.jd)?\.com\//i.test(href) || path.indexOf('/item/') !== -1;
    }
    // 拼多多商家版：/goods.html、/goods_detail.html
    if (/pinduoduo\.com|yangkeduo\.com/i.test(location.hostname)) {
      return /\/goods(_detail)?\.html/i.test(path);
    }
    return false;
  }

  // 非详情页直接返回，不注入按钮
  if (!isProductDetailPage()) return;

  // ---------------- 注入悬浮按钮 ----------------
  const button = document.createElement('button');
  button.type = 'button';
  button.className = '__ee_ext_btn';
  button.textContent = '获取图片';
  button.setAttribute('aria-label', '获取本页商品图片');
  // 插入到 body 末尾，样式由 content.css 控制（fixed 定位右下角）
  (document.body || document.documentElement).appendChild(button);

  // 按钮点击状态标志，避免重复点击触发并发扫描
  let extracting = false;

  button.addEventListener('click', async function () {
    if (extracting) return;
    extracting = true;
    setButtonLoading(true);

    try {
      const images = await extractImages();
      if (images.length === 0) {
        showToast('未提取到有效商品图片');
        return;
      }
      // 把结果交给后台，由后台存储并打开 gallery 页
      chrome.runtime.sendMessage({
        type: 'IMAGES_EXTRACTED',
        images: images,
        pageTitle: document.title || '商品详情页'
      }, function () {
        // 扩展上下文可能被关闭导致回调不触发，忽略即可
      });
    } catch (err) {
      console.error('[电商图片提取] 提取失败：', err);
      showToast('提取失败，请刷新页面重试');
    } finally {
      extracting = false;
      setButtonLoading(false);
    }
  });

  /** 按钮 loading 态切换 */
  function setButtonLoading(loading) {
    if (loading) {
      button.classList.add('__ee_ext_loading');
      button.textContent = '提取中…';
      button.disabled = true;
    } else {
      button.classList.remove('__ee_ext_loading');
      button.textContent = '获取图片';
      button.disabled = false;
    }
  }

  /** 轻量提示气泡（避免与页面样式冲突） */
  let toastTimer = null;
  function showToast(msg) {
    let toast = document.querySelector('.__ee_ext_toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = '__ee_ext_toast';
      (document.body || document.documentElement).appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('__ee_ext_show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('__ee_ext_show'), 2200);
  }

  // ---------------- 图片提取 ----------------
  /**
   * 收集候选图片 URL（含 img 的各种懒加载属性与背景图），
   * 返回去重后的 { url, width, height } 数组（尺寸尚未确定）。
   */
  function collectCandidateUrls() {
    const urlSet = new Set();
    const candidates = []; // 保留原始候选，后续逐张校验尺寸

    // 归一化：补全相对路径为绝对 URL，并做基础合法性过滤
    function pushUrl(rawUrl) {
      if (!rawUrl) return;
      let url;
      try {
        url = new URL(rawUrl, location.href).href;
      } catch (e) {
        return;
      }
      // 仅保留 http/https 协议
      if (!/^https?:/i.test(url)) return;
      if (urlSet.has(url)) return;
      urlSet.add(url);
      candidates.push({ url });
    }

    // 1) 处理 <img> 标签的多种属性
    const imgs = document.querySelectorAll('img');
    imgs.forEach(function (img) {
      // srcset：拆分为候选，取描述符最大的一项（通常是高清大图）
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
      if (srcset) {
        let best = '';
        let bestDensity = 0;
        srcset.split(',').forEach(function (part) {
          const seg = part.trim();
          if (!seg) return;
          const [u, d] = seg.split(/\s+/);
          if (!u) return;
          // 描述符可能是 2x / 1000w，统一按数值解析
          let val = 1;
          if (d) {
            const m = d.match(/[\d.]+/);
            if (m) val = parseFloat(m[0]) || 1;
          }
          if (val > bestDensity) {
            bestDensity = val;
            best = u;
          }
        });
        if (best) pushUrl(best);
      }

      // 常见懒加载/原始图属性，顺序尝试
      const attrs = [
        'src',
        'data-src',
        'data-lazy-src',
        'data-original',
        'data-url',
        'data-hi-res-src',
        'data-ks-lazyload',
        'lazy-src'
      ];
      attrs.forEach(function (a) {
        const v = img.getAttribute(a);
        if (v) pushUrl(v);
      });

      // 京东/淘宝常见的直接属性兜底
      const realSrc = img.currentSrc || img.src;
      if (realSrc && !realSrc.startsWith('data:')) pushUrl(realSrc);
    });

    // 2) 处理背景图：遍历所有元素，读取内联 style 与计算样式
    const allEls = document.querySelectorAll('*');
    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      // 内联样式背景图
      const inlineBg = el.style && el.style.backgroundImage;
      extractBgUrls(inlineBg, pushUrl);

      // 计算样式背景图（可能较慢，限制元素数量）
      let computedBg = '';
      try {
        computedBg = window.getComputedStyle(el).backgroundImage;
      } catch (e) {
        computedBg = '';
      }
      if (computedBg && computedBg !== 'none') {
        extractBgUrls(computedBg, pushUrl);
      }
    }

    return candidates;
  }

  /** 从 background-image 值中提取 url(...) */
  function extractBgUrls(bgValue, pushUrl) {
    if (!bgValue || bgValue === 'none') return;
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    let m;
    while ((m = re.exec(bgValue)) !== null) {
      if (m[2]) pushUrl(m[2]);
    }
  }

  /** 命中过滤关键词返回 true */
  function isFiltered(url, alt) {
    const text = (url + ' ' + (alt || '')).toLowerCase();
    return FILTER_KEYWORDS.some(function (kw) {
      return text.indexOf(kw) !== -1;
    });
  }

  /** 加载单张图片获取真实尺寸（不设置 crossOrigin，仅取尺寸不涉跨域污染） */
  function getImageSize(url) {
    return new Promise(function (resolve) {
      const img = new Image();
      const timer = setTimeout(function () {
        img.src = '';
        resolve(null);
      }, 8000); // 8 秒超时，避免卡住
      img.onload = function () {
        clearTimeout(timer);
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = function () {
        clearTimeout(timer);
        resolve(null);
      };
      img.src = url;
    });
  }

  /** 主提取流程：收集 → 过滤 → 校验尺寸 → 排序 */
  async function extractImages() {
    const candidates = collectCandidateUrls();

    // 逐张校验尺寸，过滤过小/无效图片
    const results = [];
    for (const item of candidates) {
      if (results.length >= MAX_IMAGES) break;

      // 关键词过滤（URL / alt 文本）
      if (isFiltered(item.url, '')) continue;

      const size = await getImageSize(item.url);
      if (!size) continue; // 加载失败

      // 过滤 1x1 像素图与小图
      if (size.width < MIN_SIZE || size.height < MIN_SIZE) continue;
      if (size.width === 1 && size.height === 1) continue;

      results.push({
        url: item.url,
        width: size.width,
        height: size.height
      });
    }

    return results;
  }
})();
