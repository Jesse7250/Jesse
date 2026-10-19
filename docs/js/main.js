/**
 * main.js —— 图提取 ImageGrab 官网交互脚本
 * 功能：
 *   1. 移动端汉堡菜单展开 / 收起
 *   2. 滚动时导航栏添加阴影（毛玻璃 + 阴影）
 *   3. 当前区块对应的导航项高亮
 *   4. 元素进入视口时触发淡入上移动画（IntersectionObserver）
 */

(function () {
  'use strict';

  // ---------- DOM 引用 ----------
  const navbar = document.getElementById('navbar');
  const hamburger = document.getElementById('hamburger');
  const nav = document.getElementById('nav');

  // ============================================================
  // 1. 移动端汉堡菜单
  // ============================================================
  if (hamburger && nav) {
    hamburger.addEventListener('click', function () {
      const isOpen = nav.classList.toggle('open');
      hamburger.classList.toggle('open', isOpen);
      hamburger.setAttribute('aria-expanded', String(isOpen));
      hamburger.setAttribute('aria-label', isOpen ? '关闭菜单' : '打开菜单');
    });

    // 点击锚点链接后自动收起移动端菜单
    nav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        nav.classList.remove('open');
        hamburger.classList.remove('open');
        hamburger.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // ============================================================
  // 2. 滚动时导航栏阴影
  // ============================================================
  function onScroll() {
    if (!navbar) return;
    navbar.classList.toggle('scrolled', window.scrollY > 10);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll(); // 初始化执行一次

  // ============================================================
  // 3. 导航项当前区块高亮（滚动监听）
  // ============================================================
  const sections = document.querySelectorAll('main section[id]');
  const navLinks = document.querySelectorAll('.nav-link');

  function highlightNav() {
    // 取当前视口中间线位置，找出其所在的区块
    const scrollPos = window.scrollY + window.innerHeight * 0.35;
    let currentId = '';

    sections.forEach(function (section) {
      if (section.offsetTop <= scrollPos) {
        currentId = section.id;
      }
    });

    navLinks.forEach(function (link) {
      const href = link.getAttribute('href');
      const isActive = href === '#' + currentId;
      link.classList.toggle('active', isActive);
    });
  }
  window.addEventListener('scroll', highlightNav, { passive: true });
  highlightNav();

  // ============================================================
  // 4. 进入视口淡入动画（IntersectionObserver）
  // ============================================================
  const revealEls = document.querySelectorAll('.reveal');

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          obs.unobserve(entry.target); // 动画只触发一次，避免重复
        }
      });
    }, {
      threshold: 0.15,
      rootMargin: '0px 0px -40px 0px'
    });

    revealEls.forEach(function (el) { observer.observe(el); });
  } else {
    // 兜底：不支持 IntersectionObserver 时直接显示
    revealEls.forEach(function (el) { el.classList.add('visible'); });
  }
})();
