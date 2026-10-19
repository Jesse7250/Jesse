/**
 * background.js —— Service Worker（Manifest V3）
 * 职责：
 *   1. 接收 content 脚本传来的图片列表，存储并打开 gallery.html
 *   2. 接收 gallery 页发来的下载请求，逐张下载
 *   3. 通过 fetch + createImageBitmap + OffscreenCanvas 将图片统一转为 PNG
 *   4. 下载过程向 gallery 页广播进度，完成后广播结果
 */

'use strict';

// 存储图片列表所用的 storage key
const STORAGE_KEY = 'galleryImages';

/**
 * 图片转 PNG Blob
 * 流程：fetch 拉取二进制 → createImageBitmap 解码 → OffscreenCanvas 重绘 → 导出 PNG
 * 若跨域/网络/解码失败，返回 null，由调用方降级为原格式下载。
 */
async function toPngBlob(url) {
  try {
    // fetch 跨域图片：manifest 中已声明 host_permissions，可绕过 CORS
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);

    // OffscreenCanvas 在 Service Worker 中可用，用于离屏绘制并导出 PNG
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);

    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    bitmap.close();
    return pngBlob;
  } catch (err) {
    console.warn('[电商图片提取] PNG 转换失败，将降级原格式下载：', url, err);
    return null;
  }
}

/** Blob → dataURL（用于 chrome.downloads.download，最稳妥） */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader 读取失败'));
    reader.readAsDataURL(blob);
  });
}

/** 从 URL 中解析出文件扩展名（小写，不含点），失败返回 'jpg' */
function getExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
    if (m) return m[1].toLowerCase();
  } catch (e) {
    /* ignore */
  }
  return 'jpg';
}

/** 序号补零，如 3 → "003" */
function padIndex(index, length = 3) {
  return String(index).padStart(length, '0');
}

/** 从图片数据计算原始扩展名（仅降级时使用） */
function originExt(url) {
  const ext = getExtFromUrl(url);
  // 仅保留常见图片扩展，避免下载成 .html 等
  const allow = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'];
  return allow.indexOf(ext) !== -1 ? ext : 'jpg';
}

/**
 * 安全广播消息给扩展其它页面（如 gallery）。
 * MV3 中 sendMessage 返回 Promise，无接收方时会异步 reject，
 * 这里显式吞掉 reject，避免产生未处理的 Promise rejection。
 */
function broadcast(payload) {
  try {
    const p = chrome.runtime.sendMessage(payload);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {
    /* 无接收方时忽略 */
  }
}

/**
 * 用回调 + chrome.runtime.lastError 封装 downloads.download，
 * 返回 Promise，兼容不支持 Promise 化 API 的版本，并可靠捕获下载失败。
 */
function downloadItem(opts) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(opts, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(downloadId);
    });
  });
}

// ---------------- 消息监听 ----------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 异步处理：返回 true 表示稍后调用 sendResponse（或使用 await）
  handleMessage(message, sender)
    .then((resp) => safeSendResponse(sendResponse, resp || {}))
    .catch((err) => {
      console.error('[电商图片提取] 处理消息失败：', err);
      safeSendResponse(sendResponse, { ok: false, error: String(err) });
    });
  return true; // 保持消息通道开启
});

/** 包裹 sendResponse，避免消息端口已关闭时调用抛错 */
function safeSendResponse(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (e) {
    /* 端口已关闭，忽略 */
  }
}

async function handleMessage(message, sender) {
  if (!message || !message.type) return { ok: false };

  // 1) 收到提取结果：存储并打开 gallery
  if (message.type === 'IMAGES_EXTRACTED') {
    const images = Array.isArray(message.images) ? message.images : [];
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        images,
        pageTitle: message.pageTitle || '商品详情页',
        timestamp: Date.now()
      }
    });

    await chrome.tabs.create({
      url: chrome.runtime.getURL('gallery.html')
    });
    return { ok: true, count: images.length };
  }

  // 2) 收到下载请求：逐张下载并上报进度
  if (message.type === 'DOWNLOAD_IMAGES') {
    const images = Array.isArray(message.images) ? message.images : [];
    const total = images.length;
    let ok = 0;
    let fail = 0;
    const failures = [];

    for (let i = 0; i < total; i++) {
      const item = images[i];
      const index = item.index != null ? item.index : i + 1;
      const seq = padIndex(index);

      try {
        const downloaded = await downloadOne(item.url, seq);
        if (downloaded) {
          ok++;
        } else {
          fail++;
          failures.push({ url: item.url, reason: '转换或下载失败' });
        }
      } catch (err) {
        fail++;
        failures.push({ url: item.url, reason: String(err) });
      }

      // 每完成一张广播进度
      broadcast({
        type: 'DOWNLOAD_PROGRESS',
        current: i + 1,
        total,
        ok,
        fail
      });
    }

    // 全部完成，广播结果
    broadcast({
      type: 'DOWNLOAD_COMPLETE',
      total,
      ok,
      fail,
      failures
    });

    return { ok: true, total, success: ok, fail };
  }

  return { ok: false };
}

/**
 * 下载单张图片
 * 优先转换为 PNG 下载；转换失败时降级为原格式下载。
 * 返回 true 表示成功发起下载。
 */
async function downloadOne(url, seq) {
  // 1) 尝试转 PNG
  const pngBlob = await toPngBlob(url);
  if (pngBlob && pngBlob.size > 0) {
    try {
      const dataUrl = await blobToDataUrl(pngBlob);
      await downloadItem({
        url: dataUrl,
        filename: `商品图_${seq}.png`,
        saveAs: false,
        conflictAction: 'uniquify'
      });
      return true;
    } catch (err) {
      console.warn('[电商图片提取] PNG 下载失败，尝试原格式：', url, err);
    }
  }

  // 2) 降级：直接下载原图（保留原始扩展名）
  try {
    const ext = originExt(url);
    await downloadItem({
      url,
      filename: `商品图_${seq}.${ext}`,
      saveAs: false,
      conflictAction: 'uniquify'
    });
    return true;
  } catch (err) {
    console.error('[电商图片提取] 原格式下载失败：', url, err);
    return false;
  }
}

// ---------------- 工具栏图标点击：兜底注入 ----------------

// 支持的平台主域（用于判断是否需要注入）
const PRODUCT_HOST_SUFFIXES = [
  'taobao.com',
  'tmall.com',
  'jd.com',
  'pinduoduo.com',
  'yangkeduo.com'
];

/** 判断主机名是否属于支持的平台 */
function isSupportedHost(hostname) {
  return PRODUCT_HOST_SUFFIXES.some(
    (d) => hostname === d || hostname.endsWith('.' + d)
  );
}

/** 判断 URL 是否为商品详情页（与 content.js 保持一致） */
function isProductDetailUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const path = u.pathname || '';
    if (/(taobao\.com|tmall\.com)$/i.test(host)) {
      return path.indexOf('/item.htm') !== -1;
    }
    if (/jd\.com$/i.test(host)) {
      return /\/item(\.jd)?\.com\//i.test(url) || path.indexOf('/item/') !== -1;
    }
    if (/(pinduoduo\.com|yangkeduo\.com)$/i.test(host)) {
      return /\/goods(_detail)?\.html/i.test(path);
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * 点击工具栏图标时，主动向当前标签页注入内容脚本。
 * 解决首次加载扩展后，已打开的详情页因未重新加载而未注入内容脚本的问题——
 * 点击图标会触发 activeTab 临时授权，无需刷新页面即可完成注入。
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null || !tab.url) return;

  let hostname = '';
  try {
    hostname = new URL(tab.url).hostname;
  } catch (e) {
    return;
  }

  if (!isSupportedHost(hostname) || !isProductDetailUrl(tab.url)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['content.css']
    });
  } catch (err) {
    console.warn('[电商图片提取] 图标注入失败：', err);
  }
});
