/**
 * gallery.js —— 图片预览与下载页逻辑
 * 职责：
 *   1. 从 chrome.storage.local 读取提取到的图片列表
 *   2. 网格化渲染缩略图、尺寸与复选框
 *   3. 全选 / 反选 / 已选数量统计
 *   4. 发起下载，并监听后台广播的进度与结果
 */

'use strict';

const STORAGE_KEY = 'galleryImages';

// DOM 引用
const gridEl = document.getElementById('grid');
const emptyStateEl = document.getElementById('emptyState');
const pageTitleEl = document.getElementById('pageTitle');
const selectedCountEl = document.getElementById('selectedCount');
const selectAllBtn = document.getElementById('selectAllBtn');
const invertBtn = document.getElementById('invertBtn');
const downloadBtn = document.getElementById('downloadBtn');
const progressWrap = document.getElementById('progressWrap');
const progressLabel = document.getElementById('progressLabel');
const progressPercent = document.getElementById('progressPercent');
const progressFill = document.getElementById('progressFill');
const resultBar = document.getElementById('resultBar');

let images = []; // 当前页面所有图片
let downloading = false; // 是否正在下载（避免重复点击）

// ---------------- 初始化 ----------------
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // 从 storage 读取数据
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const payload = data[STORAGE_KEY];
  if (payload && Array.isArray(payload.images) && payload.images.length > 0) {
    images = payload.images;
    if (payload.pageTitle) {
      pageTitleEl.textContent = payload.pageTitle;
    }
    renderGrid();
    emptyStateEl.hidden = true;
  } else {
    gridEl.hidden = true;
    emptyStateEl.hidden = false;
  }

  bindEvents();
  listenProgress();
}

// ---------------- 渲染 ----------------
function renderGrid() {
  gridEl.innerHTML = '';
  images.forEach((img, idx) => {
    const card = document.createElement('div');
    card.className = 'card';

    // 复选框
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'card-check';
    checkbox.dataset.index = String(idx);
    checkbox.checked = true; // 默认全选

    // 缩略图（懒加载）
    const imgEl = document.createElement('img');
    imgEl.className = 'card-img';
    imgEl.src = img.url;
    imgEl.loading = 'lazy';
    imgEl.alt = '商品图';

    // 底部信息：尺寸
    const info = document.createElement('div');
    info.className = 'card-info';
    info.textContent = `${img.width} × ${img.height}`;

    // 序号角标
    const badge = document.createElement('span');
    badge.className = 'card-badge';
    badge.textContent = padIndex(idx + 1);

    card.appendChild(checkbox);
    card.appendChild(imgEl);
    card.appendChild(info);
    card.appendChild(badge);

    // 点击卡片切换勾选
    card.addEventListener('click', (e) => {
      if (e.target === checkbox) return; // 避免重复触发
      checkbox.checked = !checkbox.checked;
      updateCount();
    });

    gridEl.appendChild(card);
  });

  updateCount();
}

function padIndex(index, length = 3) {
  return String(index).padStart(length, '0');
}

// ---------------- 勾选交互 ----------------
function getAllCheckboxes() {
  return Array.from(gridEl.querySelectorAll('.card-check'));
}

function getSelectedImages() {
  return getAllCheckboxes()
    .filter((cb) => cb.checked)
    .map((cb) => {
      const idx = parseInt(cb.dataset.index, 10);
      return { url: images[idx].url, index: idx + 1 };
    });
}

function updateCount() {
  const selected = getSelectedImages();
  selectedCountEl.textContent = `已选 ${selected.length} 张`;
  downloadBtn.disabled = selected.length === 0 || downloading;
}

function bindEvents() {
  selectAllBtn.addEventListener('click', () => {
    getAllCheckboxes().forEach((cb) => (cb.checked = true));
    updateCount();
  });

  invertBtn.addEventListener('click', () => {
    getAllCheckboxes().forEach((cb) => (cb.checked = !cb.checked));
    updateCount();
  });

  downloadBtn.addEventListener('click', startDownload);
}

// ---------------- 下载 ----------------
async function startDownload() {
  const selected = getSelectedImages();
  if (selected.length === 0 || downloading) return;

  downloading = true;
  downloadBtn.disabled = true;

  // 显示进度条
  progressWrap.hidden = false;
  resultBar.hidden = true;
  setProgress(0, selected.length);

  // 发送下载请求给后台 service worker
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_IMAGES',
    images: selected
  });
}

function setProgress(current, total) {
  const percent = total === 0 ? 0 : Math.round((current / total) * 100);
  progressPercent.textContent = `${percent}%`;
  progressFill.style.width = `${percent}%`;
  progressLabel.textContent = `正在下载 ${current} / ${total}`;
}

/** 监听后台广播的进度与结果消息 */
function listenProgress() {
  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;

    if (message.type === 'DOWNLOAD_PROGRESS') {
      setProgress(message.current, message.total);
    }

    if (message.type === 'DOWNLOAD_COMPLETE') {
      downloading = false;
      updateCount();

      // 结果反馈
      resultBar.hidden = false;
      if (message.fail === 0) {
        resultBar.className = 'result-bar success';
        resultBar.textContent = `下载完成：成功 ${message.ok} 张`;
      } else {
        resultBar.className = 'result-bar partial';
        resultBar.textContent = `下载完成：成功 ${message.ok} 张，失败 ${message.fail} 张`;
      }

      // 2 秒后隐藏进度条
      setTimeout(() => {
        progressWrap.hidden = true;
      }, 1500);
    }
  });
}
